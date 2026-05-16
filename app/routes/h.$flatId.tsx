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
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { data } from "react-router";
import QRCode from "qrcode";
import type { Route } from "./+types/h.$flatId";
import { db } from "../db/client";
import { flats, recipeInstances, recipes } from "../db/schema";

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

  const items = rows.map((r) => {
    const recipeUrl = `${origin}/r/${r.recipeId}?q=${r.targetQuantity}`;
    return {
      ...r,
      recipeUrl,
      bringUrl: `https://api.getbring.com/rest/bringrecipes/deeplink?url=${encodeURIComponent(recipeUrl)}`,
    };
  });

  return { flat, items, handoffUrl, qrSvg };
}

export function meta({ data: d }: Route.MetaArgs) {
  if (!d) return [];
  return [{ title: `Send to Bring! · ${d.flat.name}` }];
}

export default function Handoff({ loaderData }: Route.ComponentProps) {
  const { items, handoffUrl, qrSvg } = loaderData;

  return (
    <Container size="sm" py="md">
      <Stack gap="md">
        <Title order={1}>Send to Bring!</Title>

        {/* Desktop: QR + URL to send the page to a phone. */}
        <Card withBorder visibleFrom="sm" data-testid="handoff-desktop">
          <Stack gap="sm">
            <Text size="sm">
              Bring! lives on your phone. Open this page on your phone to share
              each recipe in.
            </Text>
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

        {/* Mobile: per-recipe share-into-Bring! links. */}
        <Box hiddenFrom="sm" data-testid="handoff-mobile">
          <Text size="sm" mb="sm">
            Tap to share each recipe into Bring!.
          </Text>
        </Box>

        {items.length === 0 ? (
          <Text c="dimmed">Nothing to shop right now.</Text>
        ) : (
          <Stack gap="xs">
            {items.map((it) => (
              <Card key={it.id} withBorder padding="sm">
                <Stack gap="xs">
                  <Anchor href={it.recipeUrl} fw={500}>
                    {it.recipeName} (serves {it.targetQuantity})
                  </Anchor>
                  <Anchor
                    href={it.bringUrl}
                    rel="external noopener"
                    aria-label={`Share ${it.recipeName} into Bring!`}
                    data-testid="bring-deeplink"
                  >
                    Share into Bring! →
                  </Anchor>
                </Stack>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
