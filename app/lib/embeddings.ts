/**
 * Cache-aware ingredient-text embeddings + similarity clustering for
 * shopping-list dedup (issue #63).
 *
 * We embed each ingredient's *item* text, cache the vectors in the
 * `ingredient_embeddings` table keyed by `(model, normalized text)`, and
 * cluster items by cosine similarity. The cache means we don't re-pay
 * for or re-wait on embeddings across recipes and flats.
 *
 * The cache key is a *normalized* form of the item text — Unicode NFC,
 * whitespace collapsed, lowercased — so that trivial variants that mean
 * the same thing ("Rote Linsen" vs "rote Linsen") share one cache entry
 * and one vector. Since they then embed to cosine 1.0 they always
 * cluster, independent of the similarity threshold. This is safe: it can
 * only ever merge texts that differ purely in case/whitespace, never
 * genuinely different ingredients.
 *
 * In tests the network is intercepted by `tests/proxy/`, which fulfils
 * the active provider's embeddings endpoint with deterministic vectors
 * (see `tests/mock-handlers.ts`).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { ingredientEmbeddings } from "../db/schema";

/**
 * Canonicalize an item text before embedding / caching. Unicode NFC +
 * whitespace collapse + lowercase. Merges only case/whitespace variants,
 * never distinct ingredients.
 */
export function normalizeForEmbedding(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Return an embedding for every distinct text in `texts`, reading from
 * the cache first and requesting only the misses from the embedding
 * provider. The returned map is keyed by the exact input text; texts
 * that normalize to the same canonical form share a single vector.
 */
export async function embedTexts(
  model: string,
  texts: string[],
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  const distinct = [...new Set(texts)];
  if (distinct.length === 0) return result;

  // Group the input texts by their normalized form; we embed and cache
  // per normalized key, then fan the vector back out to every original.
  const originalsByNorm = new Map<string, string[]>();
  for (const t of distinct) {
    const norm = normalizeForEmbedding(t);
    const list = originalsByNorm.get(norm) ?? [];
    list.push(t);
    originalsByNorm.set(norm, list);
  }
  const distinctNorm = [...originalsByNorm.keys()];
  const vecByNorm = new Map<string, number[]>();

  // 1. Cache read (keyed by normalized text).
  const cached = await db()
    .select({
      text: ingredientEmbeddings.text,
      embedding: ingredientEmbeddings.embedding,
    })
    .from(ingredientEmbeddings)
    .where(
      and(
        eq(ingredientEmbeddings.model, model),
        inArray(ingredientEmbeddings.text, distinctNorm),
      ),
    );
  for (const row of cached) vecByNorm.set(row.text, row.embedding);

  // 2. Request the misses (chunked inside requestEmbeddings).
  const misses = distinctNorm.filter((t) => !vecByNorm.has(t));
  if (misses.length > 0) {
    const fresh = await requestEmbeddings(model, misses);
    for (let i = 0; i < misses.length; i++) {
      vecByNorm.set(misses[i], fresh[i]);
    }

    // 3. Populate the cache. Concurrent finalises can race on the same
    //    (model, text); on-conflict-do-nothing keeps it idempotent.
    await db()
      .insert(ingredientEmbeddings)
      .values(misses.map((text, i) => ({ model, text, embedding: fresh[i] })))
      .onConflictDoNothing({
        target: [ingredientEmbeddings.model, ingredientEmbeddings.text],
      });
  }

  // 4. Fan the per-normalized vectors back out to the original texts.
  for (const [norm, originals] of originalsByNorm) {
    const vec = vecByNorm.get(norm);
    if (!vec) continue;
    for (const original of originals) result.set(original, vec);
  }

  return result;
}

/**
 * Embed an array of texts, dispatching to the right provider by model
 * id. `gemini-*` models go to Google's native embedding API; everything
 * else uses the OpenAI-compatible path.
 *
 * The default prod model is Google's `gemini-embedding-001` (see
 * {@link DEFAULT_EMBEDDING_MODEL} in dedup.ts). An offline eval on a
 * gold set derived from real prod ingredient texts found it clearly best
 * for German/English shopping-list dedup — it separates true synonyms
 * (Möhren/Karotten, Parmesan/Parmigiano) that OpenAI's
 * text-embedding-3-small collapses into near-neighbours, more than
 * doubling recall at zero false merges. See `ml/embedding-eval/`.
 */
async function requestEmbeddings(
  model: string,
  input: string[],
): Promise<number[][]> {
  if (model.startsWith("gemini")) return requestGeminiEmbeddings(model, input);
  return requestOpenAiEmbeddings(model, input);
}

/**
 * Raw OpenAI embeddings call (array input → array of vectors), chunked
 * to stay under the API's input-array limit and pinned to OpenAI
 * directly.
 *
 * IMPORTANT: in prod Netlify injects `OPENAI_BASE_URL` pointing at the
 * Netlify AI Gateway, which serves *chat* models only — routing
 * `text-embedding-*` there 400s. We therefore pin this client to a
 * dedicated key + base URL (`EMBEDDING_OPENAI_*`) so the gateway can't
 * hijack embeddings. This also matches the test mock, which intercepts
 * `https://api.openai.com/v1/embeddings`.
 */
const EMBEDDING_BATCH_SIZE = 512;

async function requestOpenAiEmbeddings(
  model: string,
  input: string[],
): Promise<number[][]> {
  // Lazy import so callers that never hit a cache miss (and test paths
  // that stub this) don't force the openai package to load eagerly.
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    baseURL:
      process.env.EMBEDDING_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.EMBEDDING_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  });

  // Netlify Functions cap at ~30s; bail well before the platform does.
  // A single deadline spans all chunks. On abort the call throws and
  // dedup()'s outer catch falls back to all-singletons.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const out: number[][] = [];
    for (let start = 0; start < input.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = input.slice(start, start + EMBEDDING_BATCH_SIZE);
      const res = await client.embeddings.create(
        { model, input: batch },
        { signal: controller.signal },
      );
      // The API echoes inputs back in order, but sort by index to be safe.
      const vectors = [...res.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding as number[]);
      out.push(...vectors);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Native Google Generative Language embeddings via `batchEmbedContents`
 * (array of texts → array of vectors). We request the
 * `SEMANTIC_SIMILARITY` task type (symmetric text-to-text comparison,
 * which is what clustering does) at 1024 dimensions — the config the
 * offline eval tuned the {@link DEFAULT_SIMILARITY_THRESHOLD} against.
 *
 * Reduced-dimension Gemini vectors are not L2-normalized, but we only
 * ever compare them with {@link cosineSimilarity}, which normalizes, so
 * that's fine. Auth is a dedicated key (`EMBEDDING_GEMINI_API_KEY`,
 * falling back to `GEMINI_API_KEY`) via the `x-goog-api-key` header.
 * Tests intercept `generativelanguage.googleapis.com`.
 */
const GEMINI_BATCH_SIZE = 96;
const GEMINI_OUTPUT_DIMENSIONALITY = 1024;

async function requestGeminiEmbeddings(
  model: string,
  input: string[],
): Promise<number[][]> {
  const baseURL =
    process.env.EMBEDDING_GEMINI_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta";
  const apiKey =
    process.env.EMBEDDING_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
  const url = `${baseURL}/models/${model}:batchEmbedContents`;

  // Netlify Functions cap at ~30s; bail well before the platform does.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const out: number[][] = [];
    for (let start = 0; start < input.length; start += GEMINI_BATCH_SIZE) {
      const batch = input.slice(start, start + GEMINI_BATCH_SIZE);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
        },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType: "SEMANTIC_SIMILARITY",
            outputDimensionality: GEMINI_OUTPUT_DIMENSIONALITY,
          })),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(
          `gemini embeddings: HTTP ${res.status} ${res.statusText}: ${(
            await res.text()
          ).slice(0, 300)}`,
        );
      }
      const json = (await res.json()) as {
        embeddings?: { values: number[] }[];
      };
      const vectors = json.embeddings?.map((e) => e.values);
      if (!vectors || vectors.length !== batch.length) {
        throw new Error(
          `gemini embeddings: expected ${batch.length} vectors, got ${
            vectors?.length ?? 0
          }`,
        );
      }
      out.push(...vectors);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Similarity + clustering.
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Single-linkage connected-components clustering: two items land in the
 * same cluster when their cosine similarity meets `threshold` (directly
 * or transitively). Mirrors the transitive grouping the LLM produced.
 *
 * Returns groups of indices into `embeddings`. Items missing an
 * embedding form their own singleton cluster.
 */
export function clusterBySimilarity(
  embeddings: (number[] | undefined)[],
  threshold: number,
): number[][] {
  const n = embeddings.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    const ei = embeddings[i];
    if (!ei) continue;
    for (let j = i + 1; j < n; j++) {
      const ej = embeddings[j];
      if (!ej) continue;
      if (cosineSimilarity(ei, ej) >= threshold) union(i, j);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = byRoot.get(root) ?? [];
    list.push(i);
    byRoot.set(root, list);
  }
  return [...byRoot.values()];
}
