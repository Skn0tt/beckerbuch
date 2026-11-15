/**
 * Flat pantry list: staple *names* that stay off the shopping handoff.
 *
 * Matching happens when the handoff page is read, against the current
 * list, so editing a name changes the next Bring! export without
 * rewriting recipes or the dedup snapshot. The recipe page and the
 * in-stock planned-ingredients view are not filtered — those are
 * cooking aids, and the amounts on the recipe still scale.
 *
 * A line is dropped when its item text is close to any pantry name by
 * cosine similarity. We reuse {@link embedTexts} (and therefore the
 * `ingredient_embeddings` cache and `gemini-embedding-001`).
 *
 * The cutoff is not dedup's 0.95. That value is the lowest one with
 * zero hard-negative violations on the Gemini gold set (Paprika stays
 * apart from Paprikapulver, Zitrone from Limette) and it is too tight
 * for a short staple against a more specific line ("Öl" vs "Olivenöl").
 * Ingredient search already uses 0.85 for neighbours that sit below the
 * merge cutoff. 0.90 is this job's own point in that gap: below the
 * identity cutoff, above the search floor.
 *
 * `ml/embedding-eval/` — the gold set 0.95 was tuned on — is not in
 * this repository, and this default should be re-checked against it
 * when those vectors are available. Override with
 * PANTRY_SIMILARITY_THRESHOLD.
 */
import type { DedupGroup } from "../db/schema";
import {
  cosineSimilarity,
  embedTexts,
  normalizeForEmbedding,
} from "./embeddings";

const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

export const DEFAULT_PANTRY_SIMILARITY_THRESHOLD = 0.9;

export const PANTRY_NAME_MAX = 80;
export const PANTRY_LIST_MAX = 40;

export function pantrySimilarityThreshold(): number {
  const raw = process.env.PANTRY_SIMILARITY_THRESHOLD;
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_PANTRY_SIMILARITY_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_PANTRY_SIMILARITY_THRESHOLD;
}

function embeddingModel(): string {
  return process.env.DEDUP_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
}

/** NFC, collapsed whitespace, trimmed. Empty string when nothing remains. */
export function cleanPantryName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * True when `item` is at least `threshold` similar to any pantry vector.
 * A missing item vector does not match — we keep the line rather than
 * guess.
 */
export function itemMatchesPantry(
  item: number[] | undefined,
  pantry: readonly number[][],
  threshold: number,
): boolean {
  if (!item) return false;
  for (const entry of pantry) {
    if (cosineSimilarity(item, entry) >= threshold) return true;
  }
  return false;
}

/**
 * Item strings from `items` that are close to a pantry name.
 * An empty pantry matches nothing and does not call the embedder.
 * On an embedding failure this returns an empty set (keep every line);
 * hiding food because the model is down is worse than showing a staple.
 */
export async function matchingItemTexts(
  items: readonly string[],
  pantryItems: readonly string[],
): Promise<Set<string>> {
  const pantry = [...new Set(pantryItems.map(cleanPantryName).filter(Boolean))];
  const distinct = [
    ...new Set(items.map((item) => item.trim()).filter(Boolean)),
  ];
  if (pantry.length === 0 || distinct.length === 0) return new Set();

  let vectors: Map<string, number[]>;
  try {
    vectors = await embedTexts(embeddingModel(), [...distinct, ...pantry]);
  } catch (err) {
    console.warn("[pantry] embedding match failed, keeping every line:", err);
    return new Set();
  }

  const pantryVectors = pantry
    .map((name) => vectors.get(name))
    .filter((vector): vector is number[] => vector !== undefined);
  const threshold = pantrySimilarityThreshold();
  const matched = new Set<string>();
  for (const item of distinct) {
    if (itemMatchesPantry(vectors.get(item), pantryVectors, threshold)) {
      matched.add(item);
    }
  }
  return matched;
}

/**
 * Drop shopping-list groups whose representative item is a pantry staple.
 * Rejected (split) groups go with them: their sources clustered as the
 * same item, so the representative name is the right text to compare.
 */
export async function omitPantryGroups(
  groups: DedupGroup[],
  pantryItems: readonly string[],
): Promise<DedupGroup[]> {
  if (pantryItems.length === 0 || groups.length === 0) return groups;
  const matched = await matchingItemTexts(
    groups.map((group) => group.item),
    pantryItems,
  );
  if (matched.size === 0) return groups;
  return groups.filter((group) => !matched.has(group.item.trim()));
}

/** Case-insensitive key for "is this name already on the list?". */
export function pantryNameKey(name: string): string {
  return normalizeForEmbedding(cleanPantryName(name));
}
