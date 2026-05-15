import {
  Alert,
  Anchor,
  Button,
  Container,
  Group,
  Image,
  List,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { eq, asc, count } from "drizzle-orm";
import { Form, data, redirect, useActionData } from "react-router";
import type { Route } from "./+types/recipes.$id";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf } from "../auth/csrf";
import { CsrfField } from "../auth/csrf-field";
import { isSameOrigin } from "../auth/origin";
import { deletePhoto } from "../blobs";

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
  const ings = await db()
    .select()
    .from(ingredients)
    .where(eq(ingredients.recipeId, recipe.id))
    .orderBy(asc(ingredients.position));
  return { recipe, ingredients: ings, sessionId: ctx.session.id };
}

export async function action({ request, params }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
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

  await requireCsrf(request, ctx.session.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "delete") return { error: "Unknown action." };

  const [{ value: usageCount }] = await db()
    .select({ value: count() })
    .from(recipeInstances)
    .where(eq(recipeInstances.recipeId, recipe.id));
  if (usageCount > 0) {
    return {
      error:
        "This recipe is in your draft, in stock, or cooked history — remove it from there before deleting.",
    };
  }

  await db().delete(recipes).where(eq(recipes.id, recipe.id));
  if (recipe.photoBlobKey) await deletePhoto(recipe.photoBlobKey);
  return redirect("/");
}

function formatIngredient(ing: { amount: string | null; unit: string | null; item: string }): string {
  const parts: string[] = [];
  if (ing.amount) parts.push(ing.amount);
  if (ing.unit) parts.push(ing.unit);
  parts.push(ing.item);
  return parts.join(" ");
}

export default function RecipeView({ loaderData }: Route.ComponentProps) {
  const { recipe, ingredients: ings, sessionId } = loaderData;
  const actionData = useActionData<{ error?: string } | undefined>();
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Anchor href="/">← Collection</Anchor>
          <Group gap="xs">
            <Button
              component="a"
              href={`/recipes/${recipe.id}/edit`}
              variant="default"
              size="xs"
            >
              Edit
            </Button>
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm("Delete this recipe?")) e.preventDefault();
              }}
              style={{ display: "inline" }}
            >
              <CsrfField sessionId={sessionId} />
              <input type="hidden" name="intent" value="delete" />
              <Button type="submit" color="red" variant="subtle" size="xs">
                Delete
              </Button>
            </Form>
          </Group>
        </Group>

        {actionData?.error && (
          <Alert color="red" role="alert">
            {actionData.error}
          </Alert>
        )}

        <Title order={1}>{recipe.name}</Title>

        {recipe.photoBlobKey && (
          <Image
            src={`/recipes/${recipe.id}/photo`}
            alt={recipe.name}
            radius="sm"
            fit="cover"
            mah={360}
          />
        )}

        <Text c="dimmed">
          Base: {recipe.baseQuantity} {recipe.baseQuantityUnit}
        </Text>

        <section>
          <Title order={4} mb="xs">
            Ingredients ({recipe.baseQuantity} {recipe.baseQuantityUnit})
          </Title>
          <List spacing={2}>
            {ings.map((i) => (
              <List.Item key={i.id}>{formatIngredient(i)}</List.Item>
            ))}
          </List>
        </section>

        {recipe.steps.trim() && (
          <section>
            <Title order={4} mb="xs">
              Steps
            </Title>
            <Text style={{ whiteSpace: "pre-wrap" }}>{recipe.steps}</Text>
          </section>
        )}

        {recipe.sourceUrl && (
          <Text size="sm">
            Source:{" "}
            <Anchor href={recipe.sourceUrl} target="_blank" rel="noreferrer">
              {recipe.sourceHost ?? recipe.sourceUrl} ↗
            </Anchor>
          </Text>
        )}
      </Stack>
    </Container>
  );
}
