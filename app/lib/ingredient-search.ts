/**
 * Full-text search over the kitchen "Planned ingredients" list (in-stock
 * recipes only). Matches ingredient item texts via `ingredients.search_vector`
 * and in-stock recipe names via `recipes.search_vector`, then filters the
 * already-deduped combined list to groups that hit.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes } from "../db/schema";
import { buildTsQuery } from "../search";
import { loadCombinedList, type CombinedList } from "./combined-list";

export async function searchPlannedIngredients(
  flatId: string,
  query: string,
): Promise<CombinedList> {
  const combined = await loadCombinedList(flatId);
  const tsq = buildTsQuery(query.trim());
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

  const hitIngredientIds = new Set<string>();

  const itemHits = await db()
    .select({ id: ingredients.id })
    .from(ingredients)
    .where(
      and(
        inArray(ingredients.recipeId, recipeIds),
        sql`${ingredients.searchVector} @@ to_tsquery('simple', ${tsq})`,
      ),
    );
  for (const row of itemHits) hitIngredientIds.add(row.id);

  // Name-only FTS — do NOT use recipes.search_vector here: that vector
  // also contains ingredient items (weight B), so an item query would
  // match the whole recipe and pull every line into the result set.
  const recipeHits = await db()
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        inArray(recipes.id, recipeIds),
        sql`to_tsvector('simple', unaccent(coalesce(${recipes.name}, ''))) @@ to_tsquery('simple', ${tsq})`,
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

  if (hitIngredientIds.size === 0) {
    return { ...combined, combinedGroups: [] };
  }

  const filtered = combined.combinedGroups.filter((g) =>
    g.sources.some((s) => hitIngredientIds.has(s.id)),
  );

  return { ...combined, combinedGroups: filtered };
}
