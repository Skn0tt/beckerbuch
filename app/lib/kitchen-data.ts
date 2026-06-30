import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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

export type HistoryEntry = KitchenEntry & {
  cookedAt: Date;
};

export const HISTORY_PAGE_SIZE = 5;

/**
 * Load cooked recipe instances for a flat, ordered newest-first.
 * Returns at most `PAGE_SIZE` entries starting at `offset`.
 */
export async function loadCookedHistory(
  flatId: string,
  offset: number,
): Promise<{ entries: HistoryEntry[]; hasMore: boolean }> {
  const baseSelect = {
    id: recipeInstances.id,
    targetQuantity: recipeInstances.targetQuantity,
    position: recipeInstances.position,
    recipeId: recipes.id,
    recipeName: recipes.name,
    baseQuantity: recipes.baseQuantity,
    designatedCookId: recipeInstances.designatedCookId,
    note: recipeInstances.note,
    cookedAt: recipeInstances.cookedAt,
  };

  // Fetch one extra to detect whether more pages exist.
  const rows = await db()
    .select(baseSelect)
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        isNotNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(desc(recipeInstances.cookedAt))
    .limit(HISTORY_PAGE_SIZE + 1)
    .offset(offset);

  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  // Use a type guard to narrow cookedAt from Date|null to Date — the WHERE
  // clause above guarantees non-null, but Drizzle's inferred type doesn't
  // reflect that yet.
  const page = rows
    .slice(0, HISTORY_PAGE_SIZE)
    .filter((r): r is typeof r & { cookedAt: Date } => r.cookedAt !== null);

  if (page.length === 0) {
    return { entries: [], hasMore: false };
  }

  const recipeIds = [...new Set(page.map((r) => r.recipeId))];
  const ings = await db()
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

  const entries: HistoryEntry[] = page.map((r) => ({
    ...r,
    ingredients: ingsByRecipe.get(r.recipeId) ?? [],
  }));

  return { entries, hasMore };
}

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

  const [draft, stock, members] = await Promise.all([
    db()
      .select(baseSelect)
      .from(recipeInstances)
      .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
      .where(
        and(
          eq(recipeInstances.flatId, flatId),
          isNull(recipeInstances.finalisedAt),
        ),
      )
      .orderBy(asc(recipeInstances.position)),
    db()
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
      .orderBy(asc(recipeInstances.position)),
    db()
      .select({
        id: users.id,
        displayName: users.displayName,
        avatarKey: users.avatarBlobKey,
      })
      .from(flatMembers)
      .innerJoin(users, eq(users.id, flatMembers.userId))
      .where(eq(flatMembers.flatId, flatId))
      .orderBy(asc(users.displayName)),
  ]);

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
