import {
  ActionIcon,
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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { data, useLocation, useNavigate } from "react-router";
import QRCode from "qrcode";
import { z } from "zod";
import type { Route } from "./+types/h.$flatId";
import { db } from "../db/client";
import {
  flats,
  ingredients,
  recipeInstances,
  recipes,
} from "../db/schema";
import { formatIngredient } from "../lib/scale";
import {
  buildDedupInputFromData,
  snapshotDedupForFlat,
} from "../lib/dedup-snapshot";
import { computeCombinedList } from "../lib/combined-list";
import { CombinedList } from "../components/combined-list";
import { BringImport } from "../components/bring-import";
import { firstMessage, formDataToObject, parseParams } from "../lib/form";

const ParamsSchema = z.object({ flatId: z.guid() });

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("regenerate") }),
  z.object({
    intent: z.literal("split"),
    groupId: z.string().min(1, "Missing group."),
  }),
  z.object({
    intent: z.literal("unsplit"),
    groupId: z.string().min(1, "Missing group."),
  }),
]);

export async function loader({ request, params }: Route.LoaderArgs) {
  const { flatId } = parseParams(ParamsSchema, params, "Not found.");
  const [flat] = await db()
    .select({
      id: flats.id,
      name: flats.name,
      dedupGroups: flats.dedupGroups,
      dedupRejectedGroupIds: flats.dedupRejectedGroupIds,
      dedupInputHash: flats.dedupInputHash,
    })
    .from(flats)
    .where(eq(flats.id, flatId))
    .limit(1);
  if (!flat) {
    throw data("Not found.", { status: 404 });
  }
  // Subquery instead of round-tripping `max(finalised_at)` through JS
  // — see the comment in lib/dedup-snapshot.ts.
  const latestFinalisedSubquery = sql<Date>`(
    select max(${recipeInstances.finalisedAt})
    from ${recipeInstances}
    where ${recipeInstances.flatId} = ${flat.id}
  )`;
  const rows = await db()
    .select({
      id: recipeInstances.id,
      recipeId: recipes.id,
      recipeName: recipes.name,
      baseQuantity: recipes.baseQuantity,
      targetQuantity: recipeInstances.targetQuantity,
      omittedIngredientIds: recipeInstances.omittedIngredientIds,
    })
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, flat.id),
        sql`${recipeInstances.finalisedAt} = ${latestFinalisedSubquery}`,
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  const url = new URL(request.url);
  const origin = url.origin;
  const handoffUrl = `${origin}/h/${flat.id}`;

  // Batch-load all ingredients for the in-stock recipes in one query.
  const recipeIds = rows.map((r) => r.recipeId);
  const ingsQuery =
    recipeIds.length === 0
      ? null
      : db()
          .select()
          .from(ingredients)
          .where(inArray(ingredients.recipeId, recipeIds))
          .orderBy(asc(ingredients.position));
  const [allIngs, qrSvg] = await Promise.all([
    ingsQuery ?? Promise.resolve([] as never[]),
    QRCode.toString(handoffUrl, { type: "svg", margin: 1 }),
  ]);
  const omittedIngredientIds = new Set<string>();
  for (const r of rows)
    for (const id of r.omittedIngredientIds) omittedIngredientIds.add(id);
  const currentInput = buildDedupInputFromData(rows, allIngs, omittedIngredientIds);
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
  // If the saved snapshot is missing or stale (recipes/ingredients
  // changed since Finalise), we still render an unmerged combined list
  // but mark it as stale so the user can regenerate.
  const { combinedGroups, snapshotFresh, rejectedIds } =
    await computeCombinedList(flat, currentInput);
  const rejectedSet = new Set(rejectedIds);

  // The exact lines that go into the JSON-LD recipeIngredient. Rejected
  // groups expand back to their source lines.
  const allIngredients: string[] = combinedGroups.flatMap((g) =>
    rejectedSet.has(g.id)
      ? g.sources.map((s) => s.displayText)
      : [g.displayText],
  );

  return {
    flat: { id: flat.id, name: flat.name },
    groups,
    allIngredients,
    combinedGroups,
    rejectedIds,
    snapshotFresh,
    handoffUrl,
    qrSvg,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { flatId } = parseParams(ParamsSchema, params, "Not found.");
  const [flat] = await db()
    .select({ id: flats.id, dedupRejectedGroupIds: flats.dedupRejectedGroupIds })
    .from(flats)
    .where(eq(flats.id, flatId))
    .limit(1);
  if (!flat) {
    throw data("Not found.", { status: 404 });
  }

  const form = await request.formData();
  const parsed = ActionSchema.safeParse(formDataToObject(form));
  if (!parsed.success) {
    return { error: firstMessage(parsed.error) };
  }

  if (parsed.data.intent === "regenerate") {
    await snapshotDedupForFlat(flat.id);
    return { ok: true };
  }

  // split | unsplit
  const current = new Set(flat.dedupRejectedGroupIds ?? []);
  if (parsed.data.intent === "split") current.add(parsed.data.groupId);
  else current.delete(parsed.data.groupId);
  await db()
    .update(flats)
    .set({ dedupRejectedGroupIds: [...current] })
    .where(eq(flats.id, flat.id));
  return { ok: true };
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
  const location = useLocation();
  const navigate = useNavigate();

  // This page lives outside the authenticated app shell (it's a public,
  // shareable link), so it has no header/back chrome of its own. Offer a back
  // arrow only when we arrived here with in-app history (e.g. after Finalise) —
  // location.key is "default" when the link was opened cold, where there is
  // nothing to go back to.
  const showBack = location.key !== "default";

  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "Recipe",
    name: `Shopping list — ${flat.name}`,
    author: { "@type": "Organization", name: flat.name },
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
        <Group gap="xs" wrap="nowrap">
          {/* Always mount the back slot (toggling only visibility) so the
              "Shopping list" title keeps the same x-position whether or not
              the back arrow is offered. */}
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label="Back"
            onClick={() => navigate(-1)}
            tabIndex={showBack ? undefined : -1}
            aria-hidden={showBack ? undefined : true}
            style={{ visibility: showBack ? "visible" : "hidden" }}
          >
            <Text component="span" fz={24} lh={1}>
              ←
            </Text>
          </ActionIcon>
          <Title order={1}>Shopping list</Title>
        </Group>

        {groups.length === 0 ? (
          <Text c="dimmed">Nothing to shop right now.</Text>
        ) : (
          <>
            <Stack gap={4}>
              <BringImport url={handoffUrl} />
              <Text size="xs" c="dimmed">
                Opens Bring! to import this list.
              </Text>
            </Stack>

            {/* Desktop fallback: QR + copy-link if the widget doesn't open
                Bring! on this machine. Drop once we know the button works
                on desktop. */}
            <Card withBorder visibleFrom="sm" data-testid="handoff-desktop">
              <Stack gap="sm">
                <Title order={2} size="h5">
                  Or open this page on your phone
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

            {/* Combined deduped list (issue #7). */}
            <CombinedList
              title="Combined list"
              interactive
              combinedGroups={combinedGroups}
              rejectedIds={rejectedIds}
              snapshotFresh={snapshotFresh}
            />

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
