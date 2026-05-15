import { Anchor, Container, Group, Stack, Title } from "@mantine/core";
import { eq, asc } from "drizzle-orm";
import { data, redirect, useActionData } from "react-router";
import type { Route } from "./+types/recipes.$id.edit";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf } from "../auth/csrf";
import { isSameOrigin } from "../auth/origin";
import { RecipeForm, parseRecipeFields } from "../components/recipe-form";
import { deletePhoto, storePhoto, validatePhoto } from "../blobs";
import { updateSearchVector } from "../search";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadOwnedRecipe(request: Request, id: string) {
  const ctx = await requireFlatMember(request);
  if (!UUID_RE.test(id)) throw data("Recipe not found.", { status: 404 });
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
    sessionId: ctx.session.id,
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
  const { recipe, ingredients: ings, sessionId, photoUrl } = loaderData;
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={2}>Edit recipe</Title>
          <Anchor href={`/recipes/${recipe.id}`}>← Cancel</Anchor>
        </Group>
        <RecipeForm
          sessionId={sessionId}
          error={actionData?.error}
          submitLabel="Save changes"
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
