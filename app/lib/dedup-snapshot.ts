/**
 * Computes the dedup snapshot for the current in-stock lane of a flat
 * and writes it to flats.dedup_* columns. Used by:
 *   - the Finalise action (after the transaction commits)
 *   - the regenerate-after-edit affordance on the handoff page
 *
 * Always best-effort: any failure (LLM down, malformed response, etc.)
 * persists an all-singletons snapshot so the handoff page keeps working.
 * Returns the saved input hash.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { flats, ingredients, recipeInstances, recipes } from "../db/schema";
import { dedup, hashInput, type DedupInput } from "./dedup";
import { scaleAmount } from "./scale";

export async function buildDedupInput(flatId: string): Promise<DedupInput> {
  const [latestFinalised] = await db()
    .select({ at: sql<Date | null>`max(${recipeInstances.finalisedAt})` })
    .from(recipeInstances)
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        isNotNull(recipeInstances.finalisedAt),
      ),
    );

  if (latestFinalised.at === null) return { items: [] };

  const rows = await db()
    .select({
      recipeId: recipes.id,
      recipeName: recipes.name,
      baseQuantity: recipes.baseQuantity,
      targetQuantity: recipeInstances.targetQuantity,
    })
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        eq(recipeInstances.finalisedAt, latestFinalised.at),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  if (rows.length === 0) return { items: [] };

  const recipeIds = rows.map((r) => r.recipeId);
  const ings = await db()
    .select()
    .from(ingredients)
    .where(inArray(ingredients.recipeId, recipeIds))
    .orderBy(asc(ingredients.position));

  const byRecipe = new Map<string, (typeof rows)[number]>();
  for (const r of rows) byRecipe.set(r.recipeId, r);

  const items: DedupInput["items"] = [];
  for (const ing of ings) {
    const recipe = byRecipe.get(ing.recipeId);
    if (!recipe) continue;
    const factor =
      recipe.baseQuantity > 0 ? recipe.targetQuantity / recipe.baseQuantity : 1;
    items.push({
      id: ing.id,
      amount: scaleAmount(ing.amount, factor),
      unit: ing.unit,
      item: ing.item,
      recipeName: recipe.recipeName,
    });
  }

  return { items };
}

export async function snapshotDedupForFlat(flatId: string): Promise<string> {
  const input = await buildDedupInput(flatId);
  const inputHash = await hashInput(input);
  const { groups, model } = await dedup(input);
  await db()
    .update(flats)
    .set({
      dedupInputHash: inputHash,
      dedupGroups: groups,
      // Recompute always resets rejections — they reference old group
      // ids that no longer exist.
      dedupRejectedGroupIds: [],
      dedupGeneratedAt: new Date(),
      dedupModel: model,
    })
    .where(eq(flats.id, flatId));
  return inputHash;
}
