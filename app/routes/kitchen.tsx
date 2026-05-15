import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  Container,
  Group,
  List,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Form, useFetcher, useNavigate, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/kitchen";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes, flatMembers, users } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { csrfFieldName } from "../auth/csrf-shared";
import { CsrfField } from "../auth/csrf-field";
import { isSameOrigin } from "../auth/origin";
import type { loader as appLoader } from "./_app";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DraftIngredient = {
  recipeId: string;
  position: number;
  amount: string | null;
  unit: string | null;
  item: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const url = new URL(request.url);
  const laneParam = url.searchParams.get("lane");
  const lane: "draft" | "stock" = laneParam === "stock" ? "stock" : "draft";

  const baseSelect = {
    id: recipeInstances.id,
    targetQuantity: recipeInstances.targetQuantity,
    position: recipeInstances.position,
    recipeId: recipes.id,
    recipeName: recipes.name,
    baseQuantity: recipes.baseQuantity,
    designatedCookId: recipeInstances.designatedCookId,
  };

  const draft = await db()
    .select(baseSelect)
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, ctx.flat.id),
        isNull(recipeInstances.finalisedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  const stock = await db()
    .select(baseSelect)
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, ctx.flat.id),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  const members = await db()
    .select({ id: users.id, displayName: users.displayName })
    .from(flatMembers)
    .innerJoin(users, eq(users.id, flatMembers.userId))
    .where(eq(flatMembers.flatId, ctx.flat.id))
    .orderBy(asc(users.displayName));

  const recipeIds = [
    ...new Set([...draft.map((d) => d.recipeId), ...stock.map((s) => s.recipeId)]),
  ];
  const ings: DraftIngredient[] =
    recipeIds.length === 0
      ? []
      : await db()
          .select({
            recipeId: ingredients.recipeId,
            position: ingredients.position,
            amount: ingredients.amount,
            unit: ingredients.unit,
            item: ingredients.item,
          })
          .from(ingredients)
          .where(inArray(ingredients.recipeId, recipeIds))
          .orderBy(asc(ingredients.position));

  const ingsByRecipe = new Map<string, DraftIngredient[]>();
  for (const i of ings) {
    const arr = ingsByRecipe.get(i.recipeId) ?? [];
    arr.push(i);
    ingsByRecipe.set(i.recipeId, arr);
  }

  const withIngs = <T extends { recipeId: string }>(rows: T[]) =>
    rows.map((d) => ({ ...d, ingredients: ingsByRecipe.get(d.recipeId) ?? [] }));

  return {
    lane,
    draft: withIngs(draft),
    stock: withIngs(stock),
    csrfToken: csrfTokenForSession(ctx.session.id),
    members,
  };
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const instanceId = String(form.get("instanceId") ?? "");

  if (intent === "remove-from-draft") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    await db()
      .delete(recipeInstances)
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true };
  }

  if (intent === "update-quantity") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    const target = Number.parseInt(String(form.get("targetQuantity") ?? ""), 10);
    if (!Number.isFinite(target) || target < 1) {
      return { error: "Portions must be at least 1." };
    }
    await db()
      .update(recipeInstances)
      .set({ targetQuantity: target })
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true };
  }

  if (intent === "set-cook") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    const raw = String(form.get("cookId") ?? "");
    let cookId: string | null = null;
    if (raw !== "") {
      if (!UUID_RE.test(raw)) return { error: "Invalid cook." };
      // Validate cook is a member of this flat.
      const member = await db()
        .select({ userId: flatMembers.userId })
        .from(flatMembers)
        .where(
          and(eq(flatMembers.flatId, ctx.flat.id), eq(flatMembers.userId, raw)),
        )
        .limit(1);
      if (member.length === 0) return { error: "Cook is not in this flat." };
      cookId = raw;
    }
    await db()
      .update(recipeInstances)
      .set({ designatedCookId: cookId })
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true };
  }

  if (intent === "promote-to-stock") {
    // Stub for Phase 5 finalise: promote a single draft instance to in-stock.
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    const nextPosRow = await db()
      .select({
        next: sql<number>`coalesce(max(${recipeInstances.position}), -1) + 1`,
      })
      .from(recipeInstances)
      .where(
        and(
          eq(recipeInstances.flatId, ctx.flat.id),
          isNotNull(recipeInstances.finalisedAt),
          isNull(recipeInstances.cookedAt),
        ),
      );
    const nextPos = Number(nextPosRow[0]?.next ?? 0);
    await db()
      .update(recipeInstances)
      .set({ finalisedAt: new Date(), position: nextPos })
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true };
  }

  if (intent === "mark-cooked") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    await db()
      .update(recipeInstances)
      .set({ cookedAt: new Date(), cookedBy: ctx.user.id })
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNotNull(recipeInstances.finalisedAt),
          isNull(recipeInstances.cookedAt),
        ),
      );
    return { ok: true };
  }

  return { error: "Unknown action." };
}

function scaleAmount(amount: string | null, factor: number): string | null {
  if (amount === null) return null;
  const trimmed = amount.trim();
  let n: number | null = null;
  const fracMatch = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fracMatch) {
    const a = Number(fracMatch[1]);
    const b = Number(fracMatch[2]);
    if (b !== 0) n = a / b;
  } else {
    const parsed = Number(trimmed.replace(",", "."));
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null) return amount;
  const scaled = n * factor;
  if (Number.isInteger(scaled)) return String(scaled);
  return Number(scaled.toFixed(2)).toString();
}

function formatIngredient(ing: DraftIngredient, factor: number): string {
  const parts: string[] = [];
  const scaled = scaleAmount(ing.amount, factor);
  if (scaled) parts.push(scaled);
  if (ing.unit) parts.push(ing.unit);
  parts.push(ing.item);
  return parts.join(" ");
}

type DraftEntry = Awaited<ReturnType<typeof loader>>["draft"][number];

function DraftCard({
  entry,
  csrfToken,
  members,
}: {
  entry: DraftEntry;
  csrfToken: string;
  members: { id: string; displayName: string }[];
}) {
  const fetcher = useFetcher();
  // Optimistic target while a submit is in flight; otherwise use server value.
  const pending = fetcher.formData?.get("targetQuantity");
  const target =
    typeof pending === "string" && Number.isFinite(Number(pending))
      ? Number(pending)
      : entry.targetQuantity;

  const factor = entry.baseQuantity > 0 ? target / entry.baseQuantity : 1;

  const submitTarget = (next: number) => {
    if (next < 1) return;
    const fd = new FormData();
    fd.set("intent", "update-quantity");
    fd.set("instanceId", entry.id);
    fd.set("targetQuantity", String(next));
    fd.set(csrfFieldName(), csrfToken);
    fetcher.submit(fd, { method: "post" });
  };

  const cookFetcher = useFetcher();
  const submitCook = (cookId: string) => {
    const fd = new FormData();
    fd.set("intent", "set-cook");
    fd.set("instanceId", entry.id);
    fd.set("cookId", cookId);
    fd.set(csrfFieldName(), csrfToken);
    cookFetcher.submit(fd, { method: "post" });
  };

  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Anchor href={`/recipes/${entry.recipeId}`} fw={500}>
            {entry.recipeName}
          </Anchor>
          <Group gap="xs" wrap="nowrap">
            <Group gap={4} wrap="nowrap">
              <ActionIcon
                variant="default"
                size="sm"
                type="button"
                aria-label={`Decrease ${entry.recipeName} portions`}
                onClick={() => submitTarget(Math.max(1, target - 1))}
              >
                −
              </ActionIcon>
              <Text size="sm" w={28} ta="center" aria-live="polite">
                {target}
              </Text>
              <ActionIcon
                variant="default"
                size="sm"
                type="button"
                aria-label={`Increase ${entry.recipeName} portions`}
                onClick={() => submitTarget(target + 1)}
              >
                +
              </ActionIcon>
              <Text size="sm" c="dimmed">
                portions
              </Text>
            </Group>
            <Form method="post">
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="promote-to-stock" />
              <input type="hidden" name="instanceId" value={entry.id} />
              <Button
                type="submit"
                variant="light"
                size="xs"
                aria-label={`Move ${entry.recipeName} to in stock`}
              >
                → In stock
              </Button>
            </Form>
            <Form method="post">
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="remove-from-draft" />
              <input type="hidden" name="instanceId" value={entry.id} />
              <Button
                type="submit"
                color="red"
                variant="subtle"
                size="xs"
                aria-label={`Remove ${entry.recipeName} from draft`}
              >
                Remove
              </Button>
            </Form>
          </Group>
        </Group>

        <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
          <Text size="sm" c="dimmed">Cook:</Text>
          <Group gap={4} wrap="wrap">
            <Button
              variant={entry.designatedCookId === null ? "filled" : "default"}
              size="xs"
              onClick={() => submitCook("")}
              aria-label={`Set cook to unassigned for ${entry.recipeName}`}
              aria-pressed={entry.designatedCookId === null}
            >
              Unassigned
            </Button>
            {members.map((m) => (
              <Button
                key={m.id}
                variant={entry.designatedCookId === m.id ? "filled" : "default"}
                size="xs"
                onClick={() => submitCook(m.id)}
                aria-label={`Set cook to ${m.displayName} for ${entry.recipeName}`}
                aria-pressed={entry.designatedCookId === m.id}
              >
                {m.displayName}
              </Button>
            ))}
          </Group>
        </Group>

        <List spacing={2} size="sm" c="dimmed" withPadding>
          {entry.ingredients.map((i) => (
            <List.Item key={i.position}>{formatIngredient(i, factor)}</List.Item>
          ))}
        </List>
      </Stack>
    </Card>
  );
}

function StockCard({
  entry,
  csrfToken,
}: {
  entry: DraftEntry;
  csrfToken: string;
}) {
  const factor =
    entry.baseQuantity > 0 ? entry.targetQuantity / entry.baseQuantity : 1;
  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Anchor href={`/recipes/${entry.recipeId}`} fw={500}>
            {entry.recipeName}
          </Anchor>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed">
              {entry.targetQuantity} portions
            </Text>
            <Form method="post">
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="mark-cooked" />
              <input type="hidden" name="instanceId" value={entry.id} />
              <Button
                type="submit"
                color="green"
                variant="light"
                size="xs"
                aria-label={`Mark ${entry.recipeName} as cooked`}
              >
                ✓ Cooked
              </Button>
            </Form>
          </Group>
        </Group>
        <List spacing={2} size="sm" c="dimmed" withPadding>
          {entry.ingredients.map((i) => (
            <List.Item key={i.position}>{formatIngredient(i, factor)}</List.Item>
          ))}
        </List>
      </Stack>
    </Card>
  );
}

export default function Kitchen({ loaderData }: Route.ComponentProps) {
  const { lane, draft, stock, csrfToken, members } = loaderData;
  const navigate = useNavigate();
  const data = useRouteLoaderData("routes/_app") as
    | Awaited<ReturnType<typeof appLoader>>
    | undefined;
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={1}>Kitchen</Title>
          {data && (
            <Group gap="xs">
              <Anchor href="/" size="sm">
                Collection
              </Anchor>
              <Anchor href="/flat/settings" size="sm">
                Flat settings
              </Anchor>
              <Form method="post" action="/logout">
                <CsrfField token={data.csrfToken} />
                <Button type="submit" variant="subtle" size="xs">
                  Sign out {data.user.displayName}
                </Button>
              </Form>
            </Group>
          )}
        </Group>

        <SegmentedControl
          value={lane}
          onChange={(v) => navigate(v === "stock" ? "?lane=stock" : "?lane=draft")}
          aria-label="Kitchen lane"
          data={[
            { value: "draft", label: `Draft (${draft.length})` },
            { value: "stock", label: `In stock (${stock.length})` },
          ]}
        />

        {lane === "draft" ? (
          draft.length === 0 ? (
            <Text c="dimmed">
              Draft is empty — add recipes from the{" "}
              <Anchor href="/">collection</Anchor>.
            </Text>
          ) : (
            <Stack gap="xs">
              {draft.map((d) => (
                <DraftCard
                  key={d.id}
                  entry={d}
                  csrfToken={csrfToken}
                  members={members}
                />
              ))}
            </Stack>
          )
        ) : stock.length === 0 ? (
          <Text c="dimmed">
            Nothing in stock yet — move a draft entry across to start cooking.
          </Text>
        ) : (
          <Stack gap="xs">
            {stock.map((s) => (
              <StockCard key={s.id} entry={s} csrfToken={csrfToken} />
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
