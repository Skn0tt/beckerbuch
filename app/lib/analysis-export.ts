import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes, users } from "../db/schema";

export type AnalysisRecipeRow = {
  id: string;
  name: string;
  baseQuantity: number;
  sourceUrl: string | null;
  sourceHost: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisIngredientRow = {
  id: string;
  recipeId: string;
  position: number;
  amount: string | null;
  unit: string | null;
  item: string;
};

export type AnalysisCookedRow = {
  id: string;
  recipeId: string;
  recipeName: string;
  targetQuantity: number;
  cookedAt: string;
  cookedBy: string | null;
  designatedCook: string | null;
  finalisedAt: string | null;
  note: string | null;
};

export type AnalysisExport = {
  exportedAt: string;
  recipes: AnalysisRecipeRow[];
  ingredients: AnalysisIngredientRow[];
  cooked: AnalysisCookedRow[];
};

/**
 * Flat-scoped dump of the tables an agent needs for local analysis
 * (favourite ingredients, who cooks what, etc.). Normalized row arrays —
 * load into DuckDB / pandas and join on recipe ids. Cook/recipe names are
 * denormalized onto `cooked` so "who cooked what" needs no extra join.
 * Omits secrets, search vectors, photos, steps, and draft/in-stock instances.
 */
export async function exportAnalysisTables(flatId: string): Promise<AnalysisExport> {
  const cookedByUser = alias(users, "cooked_by_user");
  const designatedCookUser = alias(users, "designated_cook_user");

  const recipeRows = await db()
    .select({
      id: recipes.id,
      name: recipes.name,
      baseQuantity: recipes.baseQuantity,
      sourceUrl: recipes.sourceUrl,
      sourceHost: recipes.sourceHost,
      createdAt: recipes.createdAt,
      updatedAt: recipes.updatedAt,
    })
    .from(recipes)
    .where(eq(recipes.flatId, flatId))
    .orderBy(asc(recipes.name), asc(recipes.id));

  const recipeIds = recipeRows.map((r) => r.id);
  const ingredientRows =
    recipeIds.length === 0
      ? []
      : await db()
          .select({
            id: ingredients.id,
            recipeId: ingredients.recipeId,
            position: ingredients.position,
            amount: ingredients.amount,
            unit: ingredients.unit,
            item: ingredients.item,
          })
          .from(ingredients)
          .where(inArray(ingredients.recipeId, recipeIds))
          .orderBy(asc(ingredients.recipeId), asc(ingredients.position));

  const cookedRows = await db()
    .select({
      id: recipeInstances.id,
      recipeId: recipeInstances.recipeId,
      recipeName: recipes.name,
      targetQuantity: recipeInstances.targetQuantity,
      cookedAt: recipeInstances.cookedAt,
      cookedBy: cookedByUser.displayName,
      designatedCook: designatedCookUser.displayName,
      finalisedAt: recipeInstances.finalisedAt,
      note: recipeInstances.note,
    })
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .leftJoin(cookedByUser, eq(cookedByUser.id, recipeInstances.cookedBy))
    .leftJoin(
      designatedCookUser,
      eq(designatedCookUser.id, recipeInstances.designatedCookId),
    )
    .where(
      and(eq(recipeInstances.flatId, flatId), isNotNull(recipeInstances.cookedAt)),
    )
    .orderBy(desc(recipeInstances.cookedAt), asc(recipeInstances.id));

  return {
    exportedAt: new Date().toISOString(),
    recipes: recipeRows.map((row) => ({
      id: row.id,
      name: row.name,
      baseQuantity: row.baseQuantity,
      sourceUrl: row.sourceUrl,
      sourceHost: row.sourceHost,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    ingredients: ingredientRows.map((row) => ({
      id: row.id,
      recipeId: row.recipeId,
      position: row.position,
      amount: row.amount == null ? null : String(row.amount),
      unit: row.unit,
      item: row.item,
    })),
    cooked: cookedRows.map((row) => ({
      id: row.id,
      recipeId: row.recipeId,
      recipeName: row.recipeName,
      targetQuantity: row.targetQuantity,
      // isNotNull in the query; drizzle still types it as Date | null.
      cookedAt: row.cookedAt!.toISOString(),
      cookedBy: row.cookedBy,
      designatedCook: row.designatedCook,
      finalisedAt: row.finalisedAt?.toISOString() ?? null,
      note: row.note,
    })),
  };
}
