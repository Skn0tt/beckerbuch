import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { deletePhoto, storePhotoBytes, validatePhotoBytes } from "../blobs";
import { buildTsQuery, updateSearchVector } from "../search";

export type CreateRecipeIngredient = {
  position: number;
  amount: string | null;
  unit: string | null;
  item: string;
};

export type CreateRecipeInput = {
  flatId: string;
  name: string;
  baseQuantity: number;
  sourceUrl: string | null;
  sourceHost: string | null;
  steps: string;
  ingredients: CreateRecipeIngredient[];
  /** Pre-validated photo bytes. Caller is responsible for size/MIME checks. */
  photo?: { bytes: Uint8Array; contentType: string };
};

export async function createRecipe(input: CreateRecipeInput): Promise<{ id: string }> {
  const recipeId = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(recipes)
      .values({
        flatId: input.flatId,
        name: input.name,
        baseQuantity: input.baseQuantity,
        sourceUrl: input.sourceUrl,
        sourceHost: input.sourceHost,
        steps: input.steps,
      })
      .returning({ id: recipes.id });
    await tx.insert(ingredients).values(
      input.ingredients.map((p) => ({
        recipeId: row.id,
        position: p.position,
        amount: p.amount,
        unit: p.unit,
        item: p.item,
      })),
    );
    await updateSearchVector(tx, row.id);
    return row.id;
  });

  if (input.photo) {
    const key = await storePhotoBytes(
      recipeId,
      input.photo.bytes,
      input.photo.contentType,
    );
    await db()
      .update(recipes)
      .set({ photoBlobKey: key })
      .where(eq(recipes.id, recipeId));
  }

  return { id: recipeId };
}

export type RecipeListItem = {
  id: string;
  name: string;
  baseQuantity: number;
  updatedAt: Date;
};

export async function searchRecipes(input: {
  flatId: string;
  query: string;
  limit?: number;
}): Promise<RecipeListItem[]> {
  const tsq = buildTsQuery(input.query.trim());
  const limit =
    input.limit === undefined ? undefined : Math.max(1, Math.min(input.limit, 50));

  if (tsq) {
    const rankExpr = sql<number>`ts_rank_cd(${recipes.searchVector}, to_tsquery('simple', ${tsq}))`;
    const query = db()
      .select({
        id: recipes.id,
        name: recipes.name,
        baseQuantity: recipes.baseQuantity,
        updatedAt: recipes.updatedAt,
      })
      .from(recipes)
      .where(
        and(
          eq(recipes.flatId, input.flatId),
          sql`${recipes.searchVector} @@ to_tsquery('simple', ${tsq})`,
        ),
      )
      .orderBy(desc(rankExpr), desc(recipes.updatedAt), asc(recipes.id));
    return limit === undefined ? query : query.limit(limit);
  }

  const query = db()
    .select({
      id: recipes.id,
      name: recipes.name,
      baseQuantity: recipes.baseQuantity,
      updatedAt: recipes.updatedAt,
    })
    .from(recipes)
    .where(eq(recipes.flatId, input.flatId))
    .orderBy(desc(recipes.updatedAt), asc(recipes.id));
  return limit === undefined ? query : query.limit(limit);
}

export type FlatRecipe = typeof recipes.$inferSelect & {
  ingredients: Array<{
    id: string;
    recipeId: string;
    position: number;
    amount: string | null;
    unit: string | null;
    item: string;
  }>;
};

export async function getRecipeForFlat(input: {
  flatId: string;
  id: string;
}): Promise<FlatRecipe | null> {
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(and(eq(recipes.id, input.id), eq(recipes.flatId, input.flatId)))
    .limit(1);
  if (!recipe) return null;

  const recipeIngredients = await db()
    .select()
    .from(ingredients)
    .where(eq(ingredients.recipeId, recipe.id))
    .orderBy(asc(ingredients.position));

  return { ...recipe, ingredients: recipeIngredients };
}

export type EditRecipeIngredient = {
  position: number;
  amount: string | null;
  unit: string | null;
  item: string;
};

export type EditRecipePatch = {
  name?: string;
  baseQuantity?: number;
  sourceUrl?: string | null;
  steps?: string;
  ingredients?: EditRecipeIngredient[];
  photo?: { bytes: Uint8Array; contentType: string };
  removePhoto?: boolean;
};

export async function editRecipe(input: {
  flatId: string;
  id: string;
  patch: EditRecipePatch;
}): Promise<FlatRecipe | null> {
  if (input.patch.photo && input.patch.removePhoto) {
    throw new Error("photo and removePhoto cannot be used together.");
  }

  const current = await getRecipeForFlat({ flatId: input.flatId, id: input.id });
  if (!current) return null;

  let nextPhotoKey: string | null | undefined = undefined;
  let oldKeyToDelete: string | null = null;
  if (input.patch.photo) {
    nextPhotoKey = await storePhotoBytes(
      input.id,
      input.patch.photo.bytes,
      input.patch.photo.contentType,
    );
    oldKeyToDelete = current.photoBlobKey;
  } else if (input.patch.removePhoto && current.photoBlobKey) {
    nextPhotoKey = null;
    oldKeyToDelete = current.photoBlobKey;
  }

  const sourceUrlChanged = input.patch.sourceUrl !== undefined;
  const nextSourceHost = sourceUrlChanged
    ? input.patch.sourceUrl
      ? new URL(input.patch.sourceUrl).host
      : null
    : undefined;
  const shouldUpdateSearchVector =
    input.patch.name !== undefined ||
    input.patch.steps !== undefined ||
    sourceUrlChanged ||
    input.patch.ingredients !== undefined;

  await db().transaction(async (tx) => {
    await tx
      .update(recipes)
      .set({
        ...(input.patch.name !== undefined ? { name: input.patch.name } : {}),
        ...(input.patch.baseQuantity !== undefined
          ? { baseQuantity: input.patch.baseQuantity }
          : {}),
        ...(input.patch.steps !== undefined ? { steps: input.patch.steps } : {}),
        ...(sourceUrlChanged
          ? {
              sourceUrl: input.patch.sourceUrl ?? null,
              sourceHost: nextSourceHost ?? null,
            }
          : {}),
        ...(nextPhotoKey !== undefined ? { photoBlobKey: nextPhotoKey } : {}),
        updatedAt: new Date(),
      })
      .where(eq(recipes.id, input.id));

    if (input.patch.ingredients) {
      await tx.delete(ingredients).where(eq(ingredients.recipeId, input.id));
      await tx.insert(ingredients).values(
        input.patch.ingredients.map((ingredient) => ({
          recipeId: input.id,
          position: ingredient.position,
          amount: ingredient.amount,
          unit: ingredient.unit,
          item: ingredient.item,
        })),
      );
    }

    if (shouldUpdateSearchVector) {
      await updateSearchVector(tx, input.id);
    }
  });

  if (oldKeyToDelete) await deletePhoto(oldKeyToDelete);
  return getRecipeForFlat({ flatId: input.flatId, id: input.id });
}

const PHOTO_FETCH_TIMEOUT_MS = 5000;
const PHOTO_FETCH_MAX_BYTES = 5 * 1024 * 1024;

export type FetchPhotoResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; error: string };

/**
 * Fetch a remote image URL with a hard timeout and size cap, then run
 * it through the shared validator. Used by the MCP add_recipe tool.
 */
export async function fetchPhotoFromUrl(url: string): Promise<FetchPhotoResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "photoUrl is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "photoUrl must be http(s)." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : "fetch failed";
    return { ok: false, error: `Could not fetch photoUrl: ${msg}.` };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    return { ok: false, error: `photoUrl returned HTTP ${response.status}.` };
  }

  const declaredLen = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > PHOTO_FETCH_MAX_BYTES) {
    return {
      ok: false,
      error: `Photo is too large (max ${PHOTO_FETCH_MAX_BYTES / 1024 / 1024} MB).`,
    };
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim();

  const buf = await response.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength > PHOTO_FETCH_MAX_BYTES) {
    return {
      ok: false,
      error: `Photo is too large (max ${PHOTO_FETCH_MAX_BYTES / 1024 / 1024} MB).`,
    };
  }

  const v = validatePhotoBytes(bytes.byteLength, contentType);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, bytes, contentType: v.contentType };
}
