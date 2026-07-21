/**
 * Search over the kitchen "Planned ingredients" list (in-stock only).
 *
 * Two stages — letters first, meaning second:
 *   1. Text — FTS prefix and/or pg_trgm word_similarity (one pass)
 *   2. Meaning — only if text finds nothing: embed the query and rank
 *      planned items by cosine similarity (synonyms like carotten → möhren)
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  ingredients,
  recipeInstances,
  recipes,
  type DedupGroup,
} from "../db/schema";
import { buildTsQuery } from "../search";
import { cosineSimilarity, embedTexts } from "./embeddings";
import { loadCombinedList, type CombinedList } from "./combined-list";

const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
/** Lower than dedup's 0.95 — synonyms sit below the merge cutoff on Gemini. */
const DEFAULT_SEARCH_SIMILARITY_THRESHOLD = 0.85;
/**
 * pg_trgm word_similarity cutoff. Below the extension's default operator
 * threshold (0.6) so short typos like "avcad"→"avocado" (~0.33) still hit.
 */
const DEFAULT_TRIGRAM_WORD_SIMILARITY = 0.3;

export async function searchPlannedIngredients(
  flatId: string,
  query: string,
): Promise<CombinedList> {
  const combined = await loadCombinedList(flatId);
  const trimmed = query.trim();
  const tsq = buildTsQuery(trimmed);
  if (!tsq) return combined;
  if (combined.combinedGroups.length === 0) return combined;

  const inStockRecipeIds = await db()
    .select({ recipeId: recipeInstances.recipeId })
    .from(recipeInstances)
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    );
  const recipeIds = [...new Set(inStockRecipeIds.map((r) => r.recipeId))];
  if (recipeIds.length === 0) {
    return { ...combined, combinedGroups: [] };
  }

  // Stage 1 — text (letters): FTS and trigram together.
  const textHits = await findTextMatchIngredientIds(recipeIds, trimmed, tsq);
  if (textHits.size > 0) {
    return {
      ...combined,
      combinedGroups: filterGroupsByIngredientIds(
        combined.combinedGroups,
        textHits,
      ),
    };
  }

  // Stage 2 — meaning: only when text found nothing.
  try {
    const semantic = await rankGroupsByEmbedding(
      combined.combinedGroups,
      trimmed,
    );
    return { ...combined, combinedGroups: semantic };
  } catch (err) {
    console.warn("[ingredient-search] embedding fallback failed:", err);
    return { ...combined, combinedGroups: [] };
  }
}

function filterGroupsByIngredientIds(
  groups: DedupGroup[],
  ids: Set<string>,
): DedupGroup[] {
  return groups.filter((g) => g.sources.some((s) => ids.has(s.id)));
}

/**
 * Text match over in-stock ingredient items (FTS prefix OR trigram typo)
 * and in-stock recipe names (FTS only — name-only, not recipes.search_vector,
 * so an item query does not pull every line from a matching recipe).
 */
async function findTextMatchIngredientIds(
  recipeIds: string[],
  query: string,
  tsq: string,
): Promise<Set<string>> {
  const hitIngredientIds = new Set<string>();
  const trgmThreshold = Number(
    process.env.INGREDIENT_SEARCH_TRIGRAM_THRESHOLD ??
      DEFAULT_TRIGRAM_WORD_SIMILARITY,
  );

  const itemHits = await db()
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        inArray(ingredients.recipeId, recipeIds),
        sql`(
          coalesce(
            ${ingredients.searchVector},
            to_tsvector('simple', unaccent(coalesce(${ingredients.item}, '')))
          ) @@ to_tsquery('simple', unaccent(${tsq}))
          OR word_similarity(
            unaccent(lower(${query})),
            unaccent(lower(${ingredients.item}))
          ) >= ${trgmThreshold}
        )`,
      ),
    );
  for (const row of itemHits) hitIngredientIds.add(row.id);

  const recipeHits = await db()
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        inArray(recipes.id, recipeIds),
        sql`to_tsvector('simple', unaccent(coalesce(${recipes.name}, ''))) @@ to_tsquery('simple', unaccent(${tsq}))`,
      ),
    );
  if (recipeHits.length > 0) {
    const fromRecipes = await db()
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(
        inArray(
          ingredients.recipeId,
          recipeHits.map((r) => r.id),
        ),
      );
    for (const row of fromRecipes) hitIngredientIds.add(row.id);
  }

  return hitIngredientIds;
}

async function rankGroupsByEmbedding(
  groups: DedupGroup[],
  query: string,
): Promise<DedupGroup[]> {
  const model = process.env.DEDUP_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const threshold = Number(
    process.env.INGREDIENT_SEARCH_SIMILARITY_THRESHOLD ??
      DEFAULT_SEARCH_SIMILARITY_THRESHOLD,
  );

  const items = [...new Set(groups.map((g) => g.item))];
  if (items.length === 0) return [];

  // Item vectors are usually already cached from dedup; the query string is
  // typically the only possible API call (and a cache hit if searched before).
  const vectors = await embedTexts(model, [query, ...items]);
  const qVec = vectors.get(query);
  if (!qVec) return [];

  const scored: { group: DedupGroup; score: number }[] = [];
  for (const g of groups) {
    const v = vectors.get(g.item);
    if (!v) continue;
    const score = cosineSimilarity(qVec, v);
    if (score >= threshold) scored.push({ group: g, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.group.item.localeCompare(b.group.item),
  );
  return scored.map((s) => s.group);
}
