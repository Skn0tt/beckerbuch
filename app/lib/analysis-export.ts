import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  flatMembers,
  ingredients,
  recipeInstances,
  recipes,
  users,
} from "../db/schema";

export type AnalysisMemberRow = {
  id: string;
  displayName: string;
};

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
  targetQuantity: number;
  cookedAt: string;
  cookedBy: string | null;
  designatedCookId: string | null;
  finalisedAt: string | null;
  note: string | null;
};

export type AnalysisExport = {
  exportedAt: string;
  members: AnalysisMemberRow[];
  recipes: AnalysisRecipeRow[];
  ingredients: AnalysisIngredientRow[];
  cooked: AnalysisCookedRow[];
};

/**
 * Flat-scoped dump of the tables an agent needs for local analysis
 * (favourite ingredients, who cooks what, etc.). Normalized row arrays —
 * load into DuckDB / pandas and join on ids. Omits secrets, search
 * vectors, photos, steps, and draft/in-stock instances.
 */
export async function exportAnalysisTables(flatId: string): Promise<AnalysisExport> {
  const memberRows = await db()
    .select({
      id: users.id,
      displayName: users.displayName,
    })
    .from(flatMembers)
    .innerJoin(users, eq(users.id, flatMembers.userId))
    .where(eq(flatMembers.flatId, flatId))
    .orderBy(asc(users.displayName), asc(users.id));

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
      targetQuantity: recipeInstances.targetQuantity,
      cookedAt: recipeInstances.cookedAt,
      cookedBy: recipeInstances.cookedBy,
      designatedCookId: recipeInstances.designatedCookId,
      finalisedAt: recipeInstances.finalisedAt,
      note: recipeInstances.note,
    })
    .from(recipeInstances)
    .where(
      and(eq(recipeInstances.flatId, flatId), isNotNull(recipeInstances.cookedAt)),
    )
    .orderBy(desc(recipeInstances.cookedAt), asc(recipeInstances.id));

  return {
    exportedAt: new Date().toISOString(),
    members: memberRows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
    })),
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
      targetQuantity: row.targetQuantity,
      // isNotNull in the query; drizzle still types it as Date | null.
      cookedAt: row.cookedAt!.toISOString(),
      cookedBy: row.cookedBy,
      designatedCookId: row.designatedCookId,
      finalisedAt: row.finalisedAt?.toISOString() ?? null,
      note: row.note,
    })),
  };
}
