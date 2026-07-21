/**
 * Full-text search over the kitchen "Planned ingredients" list (in-stock
 * recipes only), with an embedding similarity fallback when FTS finds
 * nothing — so synonym queries like "carotten" can still surface "möhren".
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

  const ftsHits = await findFtsIngredientIds(recipeIds, tsq);
  if (ftsHits.size > 0) {
    return {
      ...combined,
      combinedGroups: combined.combinedGroups.filter((g) =>
        g.sources.some((s) => ftsHits.has(s.id)),
      ),
    };
  }

  // FTS miss — try semantic near-neighbours (carotten ↔ möhren).
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

/**
 * Match in-stock ingredient rows by item FTS, and in-stock recipes by
 * name-only FTS (not recipes.search_vector — that also contains items).
 * `coalesce` covers rows whose search_vector was never backfilled;
 * `unaccent` on the query matches vectors built with unaccent.
 */
async function findFtsIngredientIds(
  recipeIds: string[],
  tsq: string,
): Promise<Set<string>> {
  const hitIngredientIds = new Set<string>();

  const itemHits = await db()
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        inArray(ingredients.recipeId, recipeIds),
        sql`coalesce(
          ${ingredients.searchVector},
          to_tsvector('simple', unaccent(coalesce(${ingredients.item}, '')))
        ) @@ to_tsquery('simple', unaccent(${tsq}))`,
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
  scored.sort((a, b) => b.score - a.score || a.group.item.localeCompare(b.group.item));
  return scored.map((s) => s.group);
}
