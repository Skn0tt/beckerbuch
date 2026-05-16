import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  Container,
  Group,
  List,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Form, Link, redirect, useFetcher, useNavigate } from "react-router";
import type { Route } from "./+types/kitchen";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes, flatMembers, users } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { csrfFieldName } from "../auth/csrf-shared";
import { CsrfField } from "../auth/csrf-field";
import { isSameOrigin } from "../auth/origin";
import { formatIngredient as fmtIngredient } from "../lib/scale";

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
    if (!Number.isFinite(target) || target < 1 || target > 1000) {
      return { error: "Portions must be between 1 and 1000." };
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

  if (intent === "finalise") {
    // Bulk: move every draft row to in-stock. Renumber positions to
    // append after current in-stock max — preserves draft order, dodges
    // the partial unique index on (flat_id, position) WHERE in-stock.
    await db().transaction(async (tx) => {
      const maxRow = await tx
        .select({
          m: sql<number>`coalesce(max(${recipeInstances.position}), -1)`,
        })
        .from(recipeInstances)
        .where(
          and(
            eq(recipeInstances.flatId, ctx.flat.id),
            isNotNull(recipeInstances.finalisedAt),
            isNull(recipeInstances.cookedAt),
          ),
        );
      const baseM = Number(maxRow[0]?.m ?? -1);
      const drafts = await tx
        .select({ id: recipeInstances.id })
        .from(recipeInstances)
        .where(
          and(
            eq(recipeInstances.flatId, ctx.flat.id),
            isNull(recipeInstances.finalisedAt),
          ),
        )
        .orderBy(asc(recipeInstances.position));
      const now = new Date();
      for (let i = 0; i < drafts.length; i++) {
        await tx
          .update(recipeInstances)
          .set({ finalisedAt: now, position: baseM + 1 + i })
          .where(
            and(
              eq(recipeInstances.id, drafts[i].id),
              eq(recipeInstances.flatId, ctx.flat.id),
              isNull(recipeInstances.finalisedAt),
            ),
          );
      }
    });
    return redirect(`/h/${ctx.flat.id}`);
  }

  if (intent === "mark-cooked") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    const updated = await db()
      .update(recipeInstances)
      .set({ cookedAt: new Date(), cookedBy: ctx.user.id })
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNotNull(recipeInstances.finalisedAt),
          isNull(recipeInstances.cookedAt),
        ),
      )
      .returning({ id: recipeInstances.id });
    if (updated.length === 0) {
      return { error: "Already cooked or not in stock." };
    }
    return { ok: true };
  }

  if (intent === "move") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    const direction = String(form.get("direction") ?? "");
    if (direction !== "up" && direction !== "down") {
      return { error: "Invalid direction." };
    }
    // Look up the row to determine its lane.
    const rows = await db()
      .select({
        id: recipeInstances.id,
        position: recipeInstances.position,
        finalisedAt: recipeInstances.finalisedAt,
        cookedAt: recipeInstances.cookedAt,
      })
      .from(recipeInstances)
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
        ),
      )
      .limit(1);
    if (rows.length === 0) return { error: "Not found." };
    const row = rows[0];
    if (row.cookedAt !== null) return { error: "Cooked entries can't move." };
    const inDraft = row.finalisedAt === null;
    const laneCond = inDraft
      ? isNull(recipeInstances.finalisedAt)
      : and(
          isNotNull(recipeInstances.finalisedAt),
          isNull(recipeInstances.cookedAt),
        );

    // Find adjacent neighbour by position.
    const neighbours = await db()
      .select({ id: recipeInstances.id, position: recipeInstances.position })
      .from(recipeInstances)
      .where(
        and(
          eq(recipeInstances.flatId, ctx.flat.id),
          laneCond,
          direction === "up"
            ? sql`${recipeInstances.position} < ${row.position}`
            : sql`${recipeInstances.position} > ${row.position}`,
        ),
      )
      .orderBy(direction === "up" ? sql`position desc` : sql`position asc`)
      .limit(1);
    if (neighbours.length === 0) return { ok: true }; // already at edge
    const neighbour = neighbours[0];

    // 2-phase swap to avoid violating partial unique on position.
    await db().transaction(async (tx) => {
      await tx
        .update(recipeInstances)
        .set({ position: -1 - row.position })
        .where(eq(recipeInstances.id, row.id));
      await tx
        .update(recipeInstances)
        .set({ position: row.position })
        .where(eq(recipeInstances.id, neighbour.id));
      await tx
        .update(recipeInstances)
        .set({ position: neighbour.position })
        .where(eq(recipeInstances.id, row.id));
    });
    return { ok: true };
  }

  return { error: "Unknown action." };
}

function formatIngredient(ing: DraftIngredient, factor: number): string {
  return fmtIngredient(ing, factor);
}

type DraftEntry = Awaited<ReturnType<typeof loader>>["draft"][number];

function MoveButtons({
  entry,
  csrfToken,
  isFirst,
  isLast,
}: {
  entry: DraftEntry;
  csrfToken: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <Group gap={2} wrap="nowrap">
      <Form method="post">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="intent" value="move" />
        <input type="hidden" name="instanceId" value={entry.id} />
        <input type="hidden" name="direction" value="up" />
        <ActionIcon
          type="submit"
          variant="default"
          size="sm"
          disabled={isFirst}
          aria-label={`Move ${entry.recipeName} up`}
        >
          ↑
        </ActionIcon>
      </Form>
      <Form method="post">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="intent" value="move" />
        <input type="hidden" name="instanceId" value={entry.id} />
        <input type="hidden" name="direction" value="down" />
        <ActionIcon
          type="submit"
          variant="default"
          size="sm"
          disabled={isLast}
          aria-label={`Move ${entry.recipeName} down`}
        >
          ↓
        </ActionIcon>
      </Form>
    </Group>
  );
}

function DraftCard({
  entry,
  csrfToken,
  members,
  isFirst,
  isLast,
}: {
  entry: DraftEntry;
  csrfToken: string;
  members: { id: string; displayName: string }[];
  isFirst: boolean;
  isLast: boolean;
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
  // Optimistic cook selection while a submit is in flight; otherwise use
  // server value. Without this the button waits for a full POST +
  // loader revalidation round-trip before flipping aria-pressed, which
  // can exceed Playwright's default 5s assertion timeout under load.
  const pendingCookRaw = cookFetcher.formData?.get("cookId");
  const pendingCook =
    typeof pendingCookRaw === "string" ? pendingCookRaw : null;
  const effectiveCookId =
    pendingCook === null
      ? entry.designatedCookId
      : pendingCook === ""
        ? null
        : pendingCook;
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
          <Group gap="xs" wrap="nowrap">
            <MoveButtons
              entry={entry}
              csrfToken={csrfToken}
              isFirst={isFirst}
              isLast={isLast}
            />
            <Anchor component={Link} to={`/recipes/${entry.recipeId}`} fw={500}>
              {entry.recipeName}
            </Anchor>
          </Group>
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
              variant={effectiveCookId === null ? "filled" : "default"}
              size="xs"
              onClick={() => submitCook("")}
              aria-label={`Set cook to unassigned for ${entry.recipeName}`}
              aria-pressed={effectiveCookId === null}
            >
              Unassigned
            </Button>
            {members.map((m) => (
              <Button
                key={m.id}
                variant={effectiveCookId === m.id ? "filled" : "default"}
                size="xs"
                onClick={() => submitCook(m.id)}
                aria-label={`Set cook to ${m.displayName} for ${entry.recipeName}`}
                aria-pressed={effectiveCookId === m.id}
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
  isFirst,
  isLast,
}: {
  entry: DraftEntry;
  csrfToken: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  const factor =
    entry.baseQuantity > 0 ? entry.targetQuantity / entry.baseQuantity : 1;
  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <MoveButtons
              entry={entry}
              csrfToken={csrfToken}
              isFirst={isFirst}
              isLast={isLast}
            />
            <Anchor component={Link} to={`/recipes/${entry.recipeId}`} fw={500}>
              {entry.recipeName}
            </Anchor>
          </Group>
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
  return (
    <Container size="sm" py="md">
      <Stack gap="md">
        <Title order={1}>Kitchen</Title>

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
              <Anchor component={Link} to="/">collection</Anchor>.
            </Text>
          ) : (
            <Stack gap="xs">
              {draft.map((d, i) => (
                <DraftCard
                  key={d.id}
                  entry={d}
                  csrfToken={csrfToken}
                  members={members}
                  isFirst={i === 0}
                  isLast={i === draft.length - 1}
                />
              ))}
              <FinaliseButton
                csrfToken={csrfToken}
                draft={draft}
                stockCount={stock.length}
              />
            </Stack>
          )
        ) : stock.length === 0 ? (
          <Text c="dimmed">
            Nothing in stock yet — finalise the draft to start cooking.
          </Text>
        ) : (
          <Stack gap="xs">
            {stock.map((s, i) => (
              <StockCard
                key={s.id}
                entry={s}
                csrfToken={csrfToken}
                isFirst={i === 0}
                isLast={i === stock.length - 1}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

function FinaliseButton({
  csrfToken,
  draft,
  stockCount,
}: {
  csrfToken: string;
  draft: DraftEntry[];
  stockCount: number;
}) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <>
      <Group justify="flex-end" mt="sm">
        <Button onClick={open} aria-label="Finalise draft">
          Finalise →
        </Button>
      </Group>
      <Modal opened={opened} onClose={close} title="Finalise this draft?">
        <Stack gap="sm">
          <Text size="sm">This will:</Text>
          <List size="sm" withPadding>
            <List.Item>Move {draft.length} recipe(s) to In stock</List.Item>
            <List.Item>Empty the draft</List.Item>
            {stockCount > 0 ? (
              <List.Item>
                Send all {stockCount + draft.length} in-stock recipe(s) to the
                handoff page — including {stockCount} already there
              </List.Item>
            ) : (
              <List.Item>Open the Bring! handoff page</List.Item>
            )}
          </List>
          <Text size="sm" fw={500}>
            Recipes:
          </Text>
          <List size="sm" withPadding>
            {draft.map((d) => (
              <List.Item key={d.id}>
                {d.recipeName} (serves {d.targetQuantity})
              </List.Item>
            ))}
          </List>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Form method="post">
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="finalise" />
              <Button type="submit" aria-label="Confirm finalise draft">
                Finalise →
              </Button>
            </Form>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
