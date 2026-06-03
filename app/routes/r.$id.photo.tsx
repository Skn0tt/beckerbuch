import { eq } from "drizzle-orm";
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/r.$id.photo";
import { db } from "../db/client";
import { recipes } from "../db/schema";
import { readPhoto } from "../blobs";
import { parseParams } from "../lib/form";

const ParamsSchema = z.object({ id: z.guid() });

export async function loader({ request, params }: Route.LoaderArgs) {
  const { id } = parseParams(ParamsSchema, params, "Recipe not found.");
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, id))
    .limit(1);
  if (!recipe || !recipe.photoBlobKey) {
    throw data("No photo.", { status: 404 });
  }

  // Content-addressed via ?v=<blobKey> — see notes in
  // routes/recipes.$id.photo.tsx.
  const url = new URL(request.url);
  const versionMatches = url.searchParams.get("v") === recipe.photoBlobKey;
  const etag = `"${recipe.photoBlobKey}"`;
  const cacheControl = versionMatches
    ? "public, max-age=31536000, immutable"
    : "public, max-age=60";

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }

  const blob = await readPhoto(recipe.photoBlobKey);
  if (!blob) throw data("No photo.", { status: 404 });
  return new Response(blob.body, {
    headers: {
      "Content-Type": blob.contentType,
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
}
