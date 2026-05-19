import { eq } from "drizzle-orm";
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/r.$id.photo";
import { db } from "../db/client";
import { recipes } from "../db/schema";
import { readPhoto } from "../blobs";
import { parseParams } from "../lib/form";

const ParamsSchema = z.object({ id: z.guid() });

export async function loader({ params }: Route.LoaderArgs) {
  const { id } = parseParams(ParamsSchema, params, "Recipe not found.");
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, id))
    .limit(1);
  if (!recipe || !recipe.photoBlobKey) {
    throw data("No photo.", { status: 404 });
  }
  const blob = await readPhoto(recipe.photoBlobKey);
  if (!blob) throw data("No photo.", { status: 404 });
  return new Response(blob.body, {
    headers: {
      "Content-Type": blob.contentType,
      // Public route — Bring! and any UA may cache aggressively.
      "Cache-Control": "public, max-age=300",
    },
  });
}
