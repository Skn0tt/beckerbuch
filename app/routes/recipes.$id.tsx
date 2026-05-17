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
import { and, eq, asc, count, isNull, max, sql } from "drizzle-orm";
import { Form, data, Link, redirect, useActionData, useFetcher } from "react-router";
import type { Route } from "./+types/recipes.$id";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
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
  return { recipe, ingredients: ings, csrfToken: csrfTokenForSession(ctx.session.id) };
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

  if (intent === "add-to-draft") {
    const flatId = ctx.flat.id;
    // Retry on partial-unique-index collision (concurrent add).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [{ value: nextPos }] = await db()
          .select({
            value: sql<number>`coalesce(${max(recipeInstances.position)}, -1) + 1`,
          })
          .from(recipeInstances)
          .where(
            and(
              eq(recipeInstances.flatId, flatId),
              isNull(recipeInstances.finalisedAt),
            ),
          );
        await db().insert(recipeInstances).values({
          flatId,
          recipeId: recipe.id,
          targetQuantity: recipe.baseQuantity,
          position: nextPos,
        });
        return { added: true as const };
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "23505" && attempt < 2) continue; // unique_violation, retry
        throw err;
      }
    }
    return { error: "Couldn't add to draft. Please try again." };
  }

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
  const { recipe, ingredients: ings, csrfToken } = loaderData;
  const actionData = useActionData<{ added?: true; error?: string } | undefined>();
  // Add-to-draft uses a fetcher rather than the navigation Form so that
  // rapid double-clicks (legitimate: "I want two of these in the
  // draft") don't supersede each other. RR7's <Form> aborts in-flight
  // submissions on a new submit, which would silently drop the first
  // insert. Before JS hydration the form falls back to a regular
  // navigation, so we also surface the same alert via actionData.
  const addFetcher = useFetcher<{ added?: true; error?: string }>();
  const added = addFetcher.data?.added || actionData?.added;
  const addError = addFetcher.data?.error;
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Anchor component={Link} to="/">← Collection</Anchor>
          <Group gap="xs">
            <Button
              component={Link}
              to={`/recipes/${recipe.id}/edit`}
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
              <CsrfField token={csrfToken} />
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
        {addError && (
          <Alert color="red" role="alert">
            {addError}
          </Alert>
        )}
        {added && (
          <Alert color="green" role="status">
            Added to draft. <Anchor component={Link} to="/kitchen">Open Kitchen →</Anchor>
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

        <Text c="dimmed">Base: {recipe.baseQuantity} portions</Text>

        <addFetcher.Form method="post">
          <CsrfField token={csrfToken} />
          <input type="hidden" name="intent" value="add-to-draft" />
          <Button type="submit">+ Add to draft</Button>
        </addFetcher.Form>

        <section>
          <Title order={4} mb="xs">
            Ingredients ({recipe.baseQuantity} portions)
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
