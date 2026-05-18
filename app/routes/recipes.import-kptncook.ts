import type { Route } from "./+types/recipes.import-kptncook";
import { requireFlatMember } from "../auth/require";
import { requireCsrf } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { importKptncookRecipe } from "../lib/kptncook";

/**
 * JSON action. POST { input: string } → either:
 *   - { ok: true, recipe: { name, baseQuantity, sourceUrl, steps,
 *       ingredients, photo?: { contentType, base64 } } }
 *   - { ok: false, error: string }
 *
 * No DB writes — purely a lookup proxy that requires auth so we don't
 * expose the kptncook API key for arbitrary callers.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "POST required." }, { status: 405 });
  }
  if (!isSameOrigin(request)) {
    return Response.json({ ok: false, error: "Bad origin." }, { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);

  const form = await request.formData();
  const input = String(form.get("input") ?? "").trim();
  if (!input) {
    return Response.json(
      { ok: false, error: "Please provide a kptncook share URL or id." },
      { status: 400 },
    );
  }

  const result = await importKptncookRecipe(input, { includePhoto: true });
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }

  const { recipe } = result;
  return Response.json({
    ok: true,
    recipe: {
      name: recipe.name,
      baseQuantity: recipe.baseQuantity,
      sourceUrl: recipe.sourceUrl,
      steps: recipe.steps,
      ingredients: recipe.ingredients,
      photo: recipe.photo
        ? {
            contentType: recipe.photo.contentType,
            base64: Buffer.from(recipe.photo.bytes).toString("base64"),
          }
        : null,
    },
  });
}

// Force route to be action-only (no loader). Hitting GET returns 405.
export async function loader() {
  return Response.json({ ok: false, error: "POST required." }, { status: 405 });
}
