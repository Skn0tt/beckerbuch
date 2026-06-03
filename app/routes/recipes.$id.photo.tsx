import { eq } from "drizzle-orm";
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/recipes.$id.photo";
import { db } from "../db/client";
import { recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { readPhoto } from "../blobs";
import { parseParams } from "../lib/form";

const ParamsSchema = z.object({ id: z.guid() });

export async function loader({ request, params }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const { id } = parseParams(ParamsSchema, params, "Recipe not found.");
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, id))
    .limit(1);
  if (!recipe || recipe.flatId !== ctx.flat.id) {
    throw data("Recipe not found.", { status: 404 });
  }
  if (!recipe.photoBlobKey) {
    throw data("No photo.", { status: 404 });
  }

  // Content-addressed via ?v=<blobKey>: callers append the current
  // blobKey so the URL changes whenever the photo changes. When the
  // caller's `v` matches the current blobKey, ship `immutable` —
  // browsers will keep it forever. Older URLs without (or with a
  // stale) `v` still work but get a short cache.
  const url = new URL(request.url);
  const versionMatches = url.searchParams.get("v") === recipe.photoBlobKey;
  const etag = `"${recipe.photoBlobKey}"`;
  const cacheControl = versionMatches
    ? "private, max-age=31536000, immutable"
    : "private, max-age=60";

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
