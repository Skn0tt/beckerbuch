import { Anchor, Container, Group, List, Stack, Text, Title } from "@mantine/core";
import { eq, asc } from "drizzle-orm";
import { data } from "react-router";
import type { Route } from "./+types/recipes.$id";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";

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
  return { recipe, ingredients: ings };
}

function formatIngredient(ing: { amount: string | null; unit: string | null; item: string }): string {
  const parts: string[] = [];
  if (ing.amount) parts.push(ing.amount);
  if (ing.unit) parts.push(ing.unit);
  parts.push(ing.item);
  return parts.join(" ");
}

export default function RecipeView({ loaderData }: Route.ComponentProps) {
  const { recipe, ingredients: ings } = loaderData;
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Anchor href="/">← Collection</Anchor>
        </Group>

        <Title order={1}>{recipe.name}</Title>

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
