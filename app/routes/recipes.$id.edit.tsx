import { Button, Container, Stack } from "@mantine/core";
import { eq, asc } from "drizzle-orm";
import { data, Form, redirect, useActionData } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/recipes.$id.edit";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { RecipeForm, parseRecipeFields } from "../components/recipe-form";
import { CsrfField } from "../auth/csrf-field";
import { deletePhoto, storePhoto, validatePhoto } from "../blobs";
import { updateSearchVector } from "../search";
import { parseParams } from "../lib/form";

const ParamsSchema = z.object({ id: z.guid() });

async function loadOwnedRecipe(request: Request, rawId: string) {
  const ctx = await requireFlatMember(request);
  const { id } = parseParams(ParamsSchema, { id: rawId }, "Recipe not found.");
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, id))
    .limit(1);
  if (!recipe || recipe.flatId !== ctx.flat.id) {
    throw data("Recipe not found.", { status: 404 });
  }
  return { ctx, recipe };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { ctx, recipe } = await loadOwnedRecipe(request, params.id);
  const ings = await db()
    .select()
    .from(ingredients)
    .where(eq(ingredients.recipeId, recipe.id))
    .orderBy(asc(ingredients.position));
  return {
    csrfToken: csrfTokenForSession(ctx.session.id),
    recipe,
    photoUrl: recipe.photoBlobKey ? `/recipes/${recipe.id}/photo` : null,
    ingredients: ings.map((i) => ({
      amount: i.amount ?? "",
      unit: i.unit ?? "",
      item: i.item,
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const { ctx, recipe } = await loadOwnedRecipe(request, params.id);
  await requireCsrf(request, ctx.session.id);

  const form = await request.formData();
  const parsed = parseRecipeFields(form);
  if (!parsed.ok) return { error: parsed.error };

  const photoFile = form.get("photo");
  const removePhoto = form.get("removePhoto") === "1";
  let newPhotoContentType: string | null = null;
  if (photoFile instanceof File && photoFile.size > 0) {
    const v = validatePhoto(photoFile);
    if (!v.ok) return { error: v.error };
    newPhotoContentType = v.contentType;
  }

  let nextPhotoKey: string | null | undefined = undefined;
  let oldKeyToDelete: string | null = null;
  if (newPhotoContentType && photoFile instanceof File) {
    nextPhotoKey = await storePhoto(recipe.id, photoFile, newPhotoContentType);
    oldKeyToDelete = recipe.photoBlobKey;
  } else if (removePhoto && recipe.photoBlobKey) {
    nextPhotoKey = null;
    oldKeyToDelete = recipe.photoBlobKey;
  }

  await db().transaction(async (tx) => {
    await tx
      .update(recipes)
      .set({
        ...parsed.fields,
        ...(nextPhotoKey !== undefined ? { photoBlobKey: nextPhotoKey } : {}),
        updatedAt: new Date(),
      })
      .where(eq(recipes.id, recipe.id));
    await tx.delete(ingredients).where(eq(ingredients.recipeId, recipe.id));
    await tx.insert(ingredients).values(
      parsed.ingredients.map((p) => ({
        recipeId: recipe.id,
        position: p.position,
        amount: p.amount,
        unit: p.unit,
        item: p.item,
      })),
    );
    await updateSearchVector(tx, recipe.id);
  });

  if (oldKeyToDelete) await deletePhoto(oldKeyToDelete);

  return redirect(`/recipes/${recipe.id}`);
}

export default function EditRecipe({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<{ error?: string } | undefined>();
  const { recipe, ingredients: ings, csrfToken, photoUrl } = loaderData;
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Form
          id="delete-recipe-form"
          method="post"
          action={`/recipes/${recipe.id}`}
          onSubmit={(e) => {
            if (!confirm("Delete this recipe?")) e.preventDefault();
          }}
        >
          <CsrfField token={csrfToken} />
          <input type="hidden" name="intent" value="delete" />
        </Form>
        <RecipeForm
          csrfToken={csrfToken}
          error={actionData?.error}
          submitLabel="Save changes"
          secondaryAction={
            <Button
              type="submit"
              form="delete-recipe-form"
              color="red"
              variant="subtle"
            >
              Delete recipe
            </Button>
          }
          initial={{
            name: recipe.name,
            baseQuantity: recipe.baseQuantity,
            sourceUrl: recipe.sourceUrl ?? "",
            steps: recipe.steps,
            ingredients: ings,
            photoUrl,
          }}
        />
      </Stack>
    </Container>
  );
}
