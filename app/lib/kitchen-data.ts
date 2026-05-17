import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes, flatMembers, users } from "../db/schema";

export type KitchenIngredient = {
  recipeId: string;
  position: number;
  amount: string | null;
  unit: string | null;
  item: string;
};

export type KitchenEntry = {
  id: string;
  targetQuantity: number;
  position: number;
  recipeId: string;
  recipeName: string;
  baseQuantity: number;
  designatedCookId: string | null;
  note: string | null;
  ingredients: KitchenIngredient[];
};

export type KitchenMember = { id: string; displayName: string; avatarKey: string | null };

export type KitchenData = {
  draft: KitchenEntry[];
  stock: KitchenEntry[];
  members: KitchenMember[];
};

/**
 * Load Draft + In-stock entries and flat members for a flat. Shared by
 * the /kitchen route and the home-page sidebar.
 */
export async function loadKitchen(flatId: string): Promise<KitchenData> {
  const baseSelect = {
    id: recipeInstances.id,
    targetQuantity: recipeInstances.targetQuantity,
    position: recipeInstances.position,
    recipeId: recipes.id,
    recipeName: recipes.name,
    baseQuantity: recipes.baseQuantity,
    designatedCookId: recipeInstances.designatedCookId,
    note: recipeInstances.note,
  };

  const draft = await db()
    .select(baseSelect)
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        isNull(recipeInstances.finalisedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  const stock = await db()
    .select(baseSelect)
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  const members = await db()
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarKey: users.avatarBlobKey,
    })
    .from(flatMembers)
    .innerJoin(users, eq(users.id, flatMembers.userId))
    .where(eq(flatMembers.flatId, flatId))
    .orderBy(asc(users.displayName));

  const recipeIds = [
    ...new Set([...draft.map((d) => d.recipeId), ...stock.map((s) => s.recipeId)]),
  ];
  const ings: KitchenIngredient[] =
    recipeIds.length === 0
      ? []
      : await db()
          .select({
            recipeId: ingredients.recipeId,
            position: ingredients.position,
            amount: ingredients.amount,
            unit: ingredients.unit,
            item: ingredients.item,
          })
          .from(ingredients)
          .where(inArray(ingredients.recipeId, recipeIds))
          .orderBy(asc(ingredients.position));

  const ingsByRecipe = new Map<string, KitchenIngredient[]>();
  for (const i of ings) {
    const arr = ingsByRecipe.get(i.recipeId) ?? [];
    arr.push(i);
    ingsByRecipe.set(i.recipeId, arr);
  }

  const withIngs = <T extends { recipeId: string }>(rows: T[]): (T & { ingredients: KitchenIngredient[] })[] =>
    rows.map((d) => ({ ...d, ingredients: ingsByRecipe.get(d.recipeId) ?? [] }));

  return {
    draft: withIngs(draft),
    stock: withIngs(stock),
    members,
  };
}
