// Shared route-handler factories for HTTP mocks. Each function returns
// a Playwright-shaped route handler (closure) that specs hand to
// `mocks.route(...)` inline. Helpers don't *register* anything — that
// stays in the spec, next to the assertions.

import type { RouteHandler } from "./playwright-mocks/src";
import {
  KPTNCOOK_TEST_API_KEY,
  TINY_JPEG,
  type MockKptncookRecipe,
} from "./mock-data";

const SHARE_BASE = "https://share.kptncook.com";

// --------------------------------------------------------------------
// kptncook

/**
 * Handler for the kptncook share-link redirect:
 *   GET https://share.kptncook.com/<shareToken> → 302 to canonical URL.
 *
 * Tokens not in the supplied list return 404 from the handler.
 */
export function kptncookShareRedirectHandler(
  recipes: MockKptncookRecipe[],
): RouteHandler {
  const byToken = new Map(recipes.map((r) => [r.shareToken, r]));
  return async (route) => {
    const url = new URL(route.url());
    const token = url.pathname.slice(1);
    const recipe = byToken.get(token);
    if (!recipe) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 302,
      headers: { location: `${SHARE_BASE}/de/${recipe.uid}/cooking` },
    });
  };
}

/**
 * Handler for the kptncook batch-resolve endpoint:
 *   POST https://mobile.kptncook.com/recipes/search?kptnkey=...
 *
 * Requires `kptnkey` to match `KPTNCOOK_TEST_API_KEY` (the value the
 * worker fixture sets on the vite dev env).
 */
export function kptncookSearchHandler(recipes: MockKptncookRecipe[]): RouteHandler {
  const byOid = new Map(recipes.map((r) => [r.oid, r]));
  const byUid = new Map(recipes.map((r) => [r.uid, r]));
  return async (route) => {
    const url = new URL(route.url());
    if (url.searchParams.get("kptnkey") !== KPTNCOOK_TEST_API_KEY) {
      await route.fulfill({ status: 401, json: { error: "bad kptnkey" } });
      return;
    }
    let body: unknown;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    if (!Array.isArray(body)) {
      await route.fulfill({ status: 400, json: { error: "expected array body" } });
      return;
    }
    const out: Array<Record<string, unknown>> = [];
    for (const entry of body) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { identifier?: unknown; uid?: unknown };
      if (typeof e.identifier === "string") {
        const r = byOid.get(e.identifier);
        if (r) out.push(r.payload);
      } else if (typeof e.uid === "string") {
        const r = byUid.get(e.uid);
        if (r) out.push(r.payload);
      }
    }
    await route.fulfill({ status: 200, json: out });
  };
}

/** Returns a 1×1 JPEG for any path under mobile.kptncook.com/images/. */
export function kptncookImagesHandler(): RouteHandler {
  return async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: TINY_JPEG,
    });
  };
}

// --------------------------------------------------------------------
// OpenAI embeddings (shopping-list dedup, issue #63)

export type OpenAiEmbeddingOptions = { fail?: boolean };

/**
 * Deterministic embedding for a piece of text. We reduce the text to a
 * normalized key (lowercase + trim + trailing-`s` strip) and emit a
 * one-hot vector whose single hot dimension is chosen by hashing that
 * key. Identical/variant texts ("tomato" / "tomatos") therefore get the
 * *same* vector (cosine 1 → cluster together), while unrelated texts get
 * orthogonal vectors (cosine 0 → stay apart). This fabricates just
 * enough proximity to reproduce the old LLM merge assertions. (The real
 * code normalizes case/whitespace before embedding; this mock's stronger
 * normalization is a test-only device.)
 */
const EMBEDDING_DIM = 1536;

function fakeEmbedding(text: string): number[] {
  const key = text.toLowerCase().trim().replace(/s$/, "");
  // FNV-1a hash → bucket index.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const index = Math.abs(hash) % EMBEDDING_DIM;
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  vec[index] = 1;
  return vec;
}

/**
 * Handler for the OpenAI embeddings endpoint
 * (https://api.openai.com/v1/embeddings). Returns a deterministic
 * vector per input string derived from a normalized key, so
 * identical/variant ingredient texts embed identically and cluster
 * together.
 *
 * With `{ fail: true }`, returns HTTP 500 — use to exercise the app's
 * embeddings-failure fallback (all singletons).
 */
export function openAiEmbeddingHandler(
  options: OpenAiEmbeddingOptions = {},
): RouteHandler {
  return async (route) => {
    if (options.fail) {
      await route.fulfill({
        status: 500,
        json: { error: { message: "forced test failure" } },
      });
      return;
    }

    type EmbeddingRequestBody = { input?: unknown; model?: unknown };
    let body: EmbeddingRequestBody | null = null;
    try {
      const json = route.request().postDataJSON() as unknown;
      if (json && typeof json === "object") body = json as EmbeddingRequestBody;
    } catch {
      body = null;
    }

    const rawInput = body?.input;
    const inputs: string[] = Array.isArray(rawInput)
      ? rawInput.map((x) => (typeof x === "string" ? x : String(x)))
      : typeof rawInput === "string"
        ? [rawInput]
        : [];

    const data = inputs.map((text, index) => ({
      object: "embedding",
      index,
      embedding: fakeEmbedding(text),
    }));

    await route.fulfill({
      status: 200,
      json: {
        object: "list",
        data,
        model: typeof body?.model === "string" ? body.model : "text-embedding-3-small",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      },
    });
  };
}

// --------------------------------------------------------------------
// Google Gemini embeddings (native batchEmbedContents)

export type GeminiEmbeddingOptions = { fail?: boolean };

/**
 * Handler for Google's native embeddings endpoint
 * (https://generativelanguage.googleapis.com/v1beta/models/*:batchEmbedContents).
 * Mirrors {@link openAiEmbeddingHandler}: returns the same deterministic
 * per-text vector so identical/variant ingredient texts embed
 * identically and cluster together — just wrapped in Gemini's
 * `{ embeddings: [{ values }] }` response shape and reading the
 * `{ requests: [{ content: { parts: [{ text }] } }] }` request shape.
 *
 * With `{ fail: true }`, returns HTTP 500 — use to exercise the app's
 * embeddings-failure fallback (all singletons).
 */
export function geminiEmbeddingHandler(
  options: GeminiEmbeddingOptions = {},
): RouteHandler {
  return async (route) => {
    if (options.fail) {
      await route.fulfill({
        status: 500,
        json: { error: { message: "forced test failure" } },
      });
      return;
    }

    type GeminiRequestBody = {
      requests?: { content?: { parts?: { text?: unknown }[] } }[];
    };
    let body: GeminiRequestBody | null = null;
    try {
      const json = route.request().postDataJSON() as unknown;
      if (json && typeof json === "object") body = json as GeminiRequestBody;
    } catch {
      body = null;
    }

    const inputs: string[] = Array.isArray(body?.requests)
      ? body!.requests.map((r) => {
          const t = r?.content?.parts?.[0]?.text;
          return typeof t === "string" ? t : String(t ?? "");
        })
      : [];

    const embeddings = inputs.map((text) => ({ values: fakeEmbedding(text) }));

    await route.fulfill({ status: 200, json: { embeddings } });
  };
}
