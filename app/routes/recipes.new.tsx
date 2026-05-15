import { Anchor, Container, Group, Stack, Title } from "@mantine/core";
import { eq } from "drizzle-orm";
import { Link, redirect, useActionData } from "react-router";
import type { Route } from "./+types/recipes.new";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { RecipeForm, parseRecipeFields } from "../components/recipe-form";
import { storePhoto, validatePhoto } from "../blobs";
import { updateSearchVector } from "../search";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  return { csrfToken: csrfTokenForSession(ctx.session.id) };
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);

  const form = await request.formData();
  const parsed = parseRecipeFields(form);
  if (!parsed.ok) return { error: parsed.error };

  const photoFile = form.get("photo");
  let photoContentType: string | null = null;
  if (photoFile instanceof File && photoFile.size > 0) {
    const v = validatePhoto(photoFile);
    if (!v.ok) return { error: v.error };
    photoContentType = v.contentType;
  }

  const recipeId = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(recipes)
      .values({ flatId: ctx.flat.id, ...parsed.fields })
      .returning({ id: recipes.id });
    await tx.insert(ingredients).values(
      parsed.ingredients.map((p) => ({
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

  if (photoContentType && photoFile instanceof File) {
    const key = await storePhoto(recipeId, photoFile, photoContentType);
    await db()
      .update(recipes)
      .set({ photoBlobKey: key })
      .where(eq(recipes.id, recipeId));
  }

  return redirect(`/recipes/${recipeId}`);
}

export default function NewRecipe({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<{ error?: string } | undefined>();
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={2}>New recipe</Title>
          <Anchor component={Link} to="/">← Cancel</Anchor>
        </Group>
        <RecipeForm
          csrfToken={loaderData.csrfToken}
          error={actionData?.error}
          submitLabel="Save recipe"
        />
      </Stack>
    </Container>
  );
}
