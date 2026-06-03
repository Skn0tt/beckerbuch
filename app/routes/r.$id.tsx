import {
  Container,
  Image,
  List,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { asc, eq } from "drizzle-orm";
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/r.$id";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { formatIngredient } from "../lib/scale";
import { parseParams } from "../lib/form";
import { createSwrClientLoader, unwrapSwr, useSwrData } from "../lib/swr";

const ParamsSchema = z.object({ id: z.guid() });

export async function loader({ request, params }: Route.LoaderArgs) {
  const { id } = parseParams(ParamsSchema, params, "Recipe not found.");
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, id))
    .limit(1);
  if (!recipe) {
    throw data("Recipe not found.", { status: 404 });
  }
  const ings = await db()
    .select()
    .from(ingredients)
    .where(eq(ingredients.recipeId, recipe.id))
    .orderBy(asc(ingredients.position));

  const url = new URL(request.url);
  const qRaw = url.searchParams.get("q");
  const qParsed = qRaw === null ? recipe.baseQuantity : Number(qRaw);
  const targetQuantity =
    Number.isInteger(qParsed) && qParsed >= 1 && qParsed <= 1000
      ? qParsed
      : recipe.baseQuantity;
  const factor =
    recipe.baseQuantity > 0 ? targetQuantity / recipe.baseQuantity : 1;

  const imageUrl = recipe.photoBlobKey
    ? new URL(
        `/r/${recipe.id}/photo?v=${encodeURIComponent(recipe.photoBlobKey)}`,
        url.origin,
      ).toString()
    : undefined;

  return { recipe, ingredients: ings, targetQuantity, factor, imageUrl };
}

export const clientLoader = createSwrClientLoader<Awaited<ReturnType<typeof loader>>>();

export function meta({ data: raw }: Route.MetaArgs) {
  const d = raw ? unwrapSwr(raw) : null;
  if (!d) return [];
  return [{ title: d.recipe.name }];
}

export default function PublicRecipe() {
  const { recipe, ingredients: ings, targetQuantity, factor, imageUrl } =
    useSwrData<Awaited<ReturnType<typeof loader>>>();

  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "Recipe",
    name: recipe.name,
    recipeYield: `${targetQuantity} servings`,
    recipeIngredient: ings.map((i) => formatIngredient(i, factor)),
    recipeInstructions: recipe.steps || undefined,
    ...(imageUrl ? { image: imageUrl } : {}),
  };
  // Escape `<` to avoid breaking out of the script tag.
  const jsonLdHtml = JSON.stringify(jsonLd).replace(/</g, "\\u003c");

  return (
    <Container size="sm" py="md">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdHtml }}
      />
      <Stack gap="md">
        <Title order={1}>{recipe.name}</Title>
        {imageUrl ? (
          <Image src={imageUrl} alt={recipe.name} radius="md" />
        ) : null}
        <Text c="dimmed">Serves {targetQuantity}</Text>
        <Title order={2} size="h4">
          Ingredients
        </Title>
        <List>
          {ings.map((i) => (
            <List.Item key={i.id}>{formatIngredient(i, factor)}</List.Item>
          ))}
        </List>
        {recipe.steps ? (
          <>
            <Title order={2} size="h4">
              Steps
            </Title>
            <Text style={{ whiteSpace: "pre-wrap" }}>{recipe.steps}</Text>
          </>
        ) : null}
      </Stack>
    </Container>
  );
}
