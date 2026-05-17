import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { storePhotoBytes, validatePhotoBytes } from "../blobs";
import { updateSearchVector } from "../search";

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
