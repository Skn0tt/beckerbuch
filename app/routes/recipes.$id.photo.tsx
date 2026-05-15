import { eq } from "drizzle-orm";
import { data } from "react-router";
import type { Route } from "./+types/recipes.$id.photo";
import { db } from "../db/client";
import { recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { readPhoto } from "../blobs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loader({ request, params }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  if (!UUID_RE.test(params.id)) {
    throw data("Recipe not found.", { status: 404 });
  }
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, params.id))
    .limit(1);
  if (!recipe || recipe.flatId !== ctx.flat.id) {
    throw data("Recipe not found.", { status: 404 });
  }
  if (!recipe.photoBlobKey) {
    throw data("No photo.", { status: 404 });
  }
  const blob = await readPhoto(recipe.photoBlobKey);
  if (!blob) throw data("No photo.", { status: 404 });
  return new Response(blob.body, {
    headers: {
      "Content-Type": blob.contentType,
      "Cache-Control": "private, max-age=300",
    },
  });
}
