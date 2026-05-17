import {
  Anchor,
  Box,
  Button,
  Card,
  Container,
  CopyButton,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { data } from "react-router";
import QRCode from "qrcode";
import type { Route } from "./+types/h.$flatId";
import { db } from "../db/client";
import { flats, ingredients, recipeInstances, recipes } from "../db/schema";
import { formatIngredient } from "../lib/scale";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loader({ request, params }: Route.LoaderArgs) {
  if (!UUID_RE.test(params.flatId)) {
    throw data("Not found.", { status: 404 });
  }
  const [flat] = await db()
    .select({ id: flats.id, name: flats.name })
    .from(flats)
    .where(eq(flats.id, params.flatId))
    .limit(1);
  if (!flat) {
    throw data("Not found.", { status: 404 });
  }
  const rows = await db()
    .select({
      id: recipeInstances.id,
      recipeId: recipes.id,
      recipeName: recipes.name,
      baseQuantity: recipes.baseQuantity,
      targetQuantity: recipeInstances.targetQuantity,
    })
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, flat.id),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  const url = new URL(request.url);
  const origin = url.origin;
  const handoffUrl = `${origin}/h/${flat.id}`;
  const qrSvg = await QRCode.toString(handoffUrl, { type: "svg", margin: 1 });

  // Batch-load all ingredients for the in-stock recipes in one query.
  const recipeIds = rows.map((r) => r.recipeId);
  const allIngs =
    recipeIds.length > 0
      ? await db()
          .select()
          .from(ingredients)
          .where(inArray(ingredients.recipeId, recipeIds))
          .orderBy(asc(ingredients.position))
      : [];
  const ingsByRecipe = new Map<string, typeof allIngs>();
  for (const ing of allIngs) {
    const list = ingsByRecipe.get(ing.recipeId) ?? [];
    list.push(ing);
    ingsByRecipe.set(ing.recipeId, list);
  }

  const groups = rows.map((r) => {
    const ings = ingsByRecipe.get(r.recipeId) ?? [];
    const factor = r.baseQuantity > 0 ? r.targetQuantity / r.baseQuantity : 1;
    return {
      instanceId: r.id,
      recipeId: r.recipeId,
      recipeName: r.recipeName,
      targetQuantity: r.targetQuantity,
      recipeUrl: `${origin}/r/${r.recipeId}?q=${r.targetQuantity}`,
      ingredients: ings.map((i) => formatIngredient(i, factor)),
    };
  });

  const allIngredients = groups.flatMap((g) => g.ingredients);

  return { flat, groups, allIngredients, handoffUrl, qrSvg };
}

export function meta({ data: d }: Route.MetaArgs) {
  if (!d) return [];
  return [{ title: `Send to Bring! · ${d.flat.name}` }];
}

export default function Handoff({ loaderData }: Route.ComponentProps) {
  const { flat, groups, allIngredients, handoffUrl, qrSvg } = loaderData;

  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "Recipe",
    name: `Shopping list — ${flat.name}`,
    recipeYield: `${groups.reduce((s, g) => s + g.targetQuantity, 0)} servings`,
    recipeIngredient: allIngredients,
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
        <Title order={1}>Shopping list</Title>

        {groups.length === 0 ? (
          <Text c="dimmed">Nothing to shop right now.</Text>
        ) : (
          <>
            {/* Desktop: QR + copy-link card to send the page to a phone. */}
            <Card withBorder visibleFrom="sm" data-testid="handoff-desktop">
              <Stack gap="sm">
                <Title order={2} size="h5">
                  Open on your phone, then share into Bring!
                </Title>
                <Group align="center" gap="md" wrap="nowrap">
                  <Box
                    aria-label="QR code for handoff URL"
                    w={160}
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                  <Stack gap="xs">
                    <Text size="sm" style={{ wordBreak: "break-all" }}>
                      {handoffUrl}
                    </Text>
                    <CopyButton value={handoffUrl}>
                      {({ copied, copy }) => (
                        <Button size="xs" variant="default" onClick={copy}>
                          {copied ? "Copied" : "Copy link"}
                        </Button>
                      )}
                    </CopyButton>
                  </Stack>
                </Group>
              </Stack>
            </Card>

            <Text size="sm" c="dimmed" hiddenFrom="sm">
              Use your browser&apos;s Share menu and pick Bring! to import this
              list.
            </Text>

            <Stack gap="xs">
              <Title order={2} size="h4">
                Recipes in this list
              </Title>
              {groups.map((g) => (
                <Card key={g.instanceId} withBorder padding="sm">
                  <Stack gap="xs">
                    <Anchor href={g.recipeUrl} fw={500}>
                      {g.recipeName} (serves {g.targetQuantity})
                    </Anchor>
                    <Stack gap={2}>
                      {g.ingredients.map((ing, idx) => (
                        <Text key={idx} size="sm" c="dimmed">
                          {ing}
                        </Text>
                      ))}
                    </Stack>
                  </Stack>
                </Card>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Container>
  );
}
