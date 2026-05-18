import {
  Anchor,
  Badge,
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
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { data, useFetcher } from "react-router";
import QRCode from "qrcode";
import type { Route } from "./+types/h.$flatId";
import { db } from "../db/client";
import {
  flats,
  ingredients,
  recipeInstances,
  recipes,
  type DedupGroup,
} from "../db/schema";
import { formatIngredient } from "../lib/scale";
import {
  buildDedupInput,
  snapshotDedupForFlat,
} from "../lib/dedup-snapshot";
import { hashInput } from "../lib/dedup";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loader({ request, params }: Route.LoaderArgs) {
  if (!UUID_RE.test(params.flatId)) {
    throw data("Not found.", { status: 404 });
  }
  const [flat] = await db()
    .select({
      id: flats.id,
      name: flats.name,
      dedupGroups: flats.dedupGroups,
      dedupRejectedGroupIds: flats.dedupRejectedGroupIds,
      dedupInputHash: flats.dedupInputHash,
    })
    .from(flats)
    .where(eq(flats.id, params.flatId))
    .limit(1);
  if (!flat) {
    throw data("Not found.", { status: 404 });
  }
  const [latestFinalised] = await db()
    .select({ at: sql<Date | null>`max(${recipeInstances.finalisedAt})` })
    .from(recipeInstances)
    .where(
      and(
        eq(recipeInstances.flatId, flat.id),
        isNotNull(recipeInstances.finalisedAt),
      ),
    );
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
        latestFinalised.at === null
          ? sql`false`
          : eq(recipeInstances.finalisedAt, latestFinalised.at),
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

  // ---- Dedup snapshot handling --------------------------------------
  // Compute the current input hash. If the saved snapshot is missing or
  // stale (recipes/ingredients changed since Finalise), we still render
  // an unmerged combined list but mark it as stale so the user can
  // regenerate.
  const currentInput = await buildDedupInput(flat.id);
  const currentHash = await hashInput(currentInput);
  const snapshotFresh =
    flat.dedupGroups !== null &&
    flat.dedupInputHash !== null &&
    flat.dedupInputHash === currentHash;

  const rejectedIds = new Set(flat.dedupRejectedGroupIds ?? []);
  // What we actually render: the snapshot groups if fresh, otherwise
  // an all-singletons fallback derived from the current input.
  const combinedGroups: DedupGroup[] = snapshotFresh
    ? (flat.dedupGroups ?? [])
    : currentInput.items.map((it) => ({
        id: it.id,
        item: it.item,
        unit: it.unit,
        amount: it.amount,
        displayText: formatIngredient(
          { amount: it.amount, unit: it.unit, item: it.item },
          1,
        ),
        sources: [
          {
            id: it.id,
            displayText: formatIngredient(
              { amount: it.amount, unit: it.unit, item: it.item },
              1,
            ),
            recipeName: it.recipeName,
          },
        ],
      }));

  // The exact lines that go into the JSON-LD recipeIngredient. Rejected
  // groups expand back to their source lines.
  const allIngredients: string[] = combinedGroups.flatMap((g) =>
    rejectedIds.has(g.id)
      ? g.sources.map((s) => s.displayText)
      : [g.displayText],
  );

  return {
    flat: { id: flat.id, name: flat.name },
    groups,
    allIngredients,
    combinedGroups,
    rejectedIds: [...rejectedIds],
    snapshotFresh,
    handoffUrl,
    qrSvg,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  if (!UUID_RE.test(params.flatId)) {
    throw data("Not found.", { status: 404 });
  }
  const [flat] = await db()
    .select({ id: flats.id, dedupRejectedGroupIds: flats.dedupRejectedGroupIds })
    .from(flats)
    .where(eq(flats.id, params.flatId))
    .limit(1);
  if (!flat) {
    throw data("Not found.", { status: 404 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "regenerate") {
    await snapshotDedupForFlat(flat.id);
    return { ok: true };
  }

  if (intent === "split" || intent === "unsplit") {
    const groupId = String(form.get("groupId") ?? "");
    if (groupId === "") return { error: "Missing group." };
    const current = new Set(flat.dedupRejectedGroupIds ?? []);
    if (intent === "split") current.add(groupId);
    else current.delete(groupId);
    await db()
      .update(flats)
      .set({ dedupRejectedGroupIds: [...current] })
      .where(eq(flats.id, flat.id));
    return { ok: true };
  }

  return { error: "Unknown intent." };
}

export function meta({ data: d }: Route.MetaArgs) {
  if (!d) return [];
  return [{ title: `Send to Bring! · ${d.flat.name}` }];
}

export default function Handoff({ loaderData }: Route.ComponentProps) {
  const {
    flat,
    groups,
    allIngredients,
    combinedGroups,
    rejectedIds,
    snapshotFresh,
    handoffUrl,
    qrSvg,
  } = loaderData;
  const rejectedSet = new Set(rejectedIds);
  const fetcher = useFetcher();

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

            {/* Combined deduped list (issue #7). */}
            <Stack gap="xs" data-testid="combined-list">
              <Group justify="space-between" align="center">
                <Title order={2} size="h4">
                  Combined list
                </Title>
                {!snapshotFresh && (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="regenerate" />
                    <Button
                      type="submit"
                      size="xs"
                      variant="light"
                      color="yellow"
                      loading={fetcher.state !== "idle"}
                    >
                      Regenerate
                    </Button>
                  </fetcher.Form>
                )}
              </Group>
              {!snapshotFresh && (
                <Text size="xs" c="dimmed">
                  Shopping list changed since finalise — showing all
                  ingredients unmerged.
                </Text>
              )}
              <Stack gap={4}>
                {combinedGroups.map((g) => {
                  const isMerged = g.sources.length > 1;
                  const isRejected = rejectedSet.has(g.id);
                  return (
                    <Card
                      key={g.id}
                      withBorder
                      padding="xs"
                      data-testid="combined-row"
                      data-merged={isMerged ? "true" : "false"}
                      data-rejected={isRejected ? "true" : "false"}
                    >
                      <Group justify="space-between" align="flex-start" wrap="nowrap">
                        <Stack gap={2} style={{ flex: 1 }}>
                          {isMerged && !isRejected && (
                            <Text size="sm" fw={500}>
                              {g.displayText}
                            </Text>
                          )}
                          {!isMerged && (
                            <Text size="sm">{g.displayText}</Text>
                          )}
                          {isMerged &&
                            g.sources.map((s) => (
                              <Text key={s.id} size="xs" c="dimmed">
                                {isRejected ? "" : "· "}
                                {s.displayText}{" "}
                                <Text span size="xs" c="dimmed">
                                  — {s.recipeName}
                                </Text>
                              </Text>
                            ))}
                        </Stack>
                        {isMerged && (
                          <fetcher.Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value={isRejected ? "unsplit" : "split"}
                            />
                            <input type="hidden" name="groupId" value={g.id} />
                            <Button
                              type="submit"
                              size="xs"
                              variant="subtle"
                              aria-label={
                                isRejected
                                  ? `Undo split for ${g.item}`
                                  : `Split ${g.item}`
                              }
                            >
                              {isRejected ? "Undo split" : "Split"}
                            </Button>
                          </fetcher.Form>
                        )}
                        {isMerged && !isRejected && (
                          <Badge size="xs" variant="light" color="blue" hiddenFrom="sm">
                            merged
                          </Badge>
                        )}
                      </Group>
                    </Card>
                  );
                })}
              </Stack>
            </Stack>

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
