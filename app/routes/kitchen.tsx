import {
  Anchor,
  Button,
  Container,
  Divider,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Link, redirect, useNavigate, useFetcher } from "react-router";
import { useState, useEffect } from "react";
import { z } from "zod";
import type { Route } from "./+types/kitchen";
import { db } from "../db/client";
import { recipeInstances, flatMembers } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { loadKitchen } from "../lib/kitchen-data";
import type { HistoryEntry } from "../lib/kitchen-data";
import { HISTORY_PAGE_SIZE } from "../lib/kitchen-data";
import { snapshotDedupForFlat } from "../lib/dedup-snapshot";
import {
  FinaliseButton,
  HistoryCard,
  PlannedIngredients,
  SortableLane,
} from "../components/kitchen-sidebar";
import { firstMessage, formDataToObject } from "../lib/form";

const uuid = z.guid("Invalid instance.");

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("remove-from-draft"),
    instanceId: uuid,
  }),
  z.object({
    intent: z.literal("update-quantity"),
    instanceId: uuid,
    targetQuantity: z.coerce
      .number({ message: "Portions must be between 1 and 1000." })
      .int("Portions must be between 1 and 1000.")
      .min(1, "Portions must be between 1 and 1000.")
      .max(1000, "Portions must be between 1 and 1000."),
  }),
  z.object({
    intent: z.literal("set-cook"),
    instanceId: uuid,
    cookId: z.union([z.literal(""), z.guid("Invalid cook.")]),
  }),
  z.object({
    intent: z.literal("set-note"),
    instanceId: uuid,
    note: z.string().optional().default(""),
  }),
  z.object({
    intent: z.literal("reorder"),
    lane: z.enum(["draft", "stock"], { message: "Invalid lane." }),
    instanceIds: z
      .string()
      .transform((s) =>
        s
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      )
      .pipe(z.array(z.guid("Invalid order.")).min(1, "Invalid order.")),
  }),
  z.object({ intent: z.literal("finalise") }),
  z.object({
    intent: z.literal("mark-cooked"),
    instanceId: uuid,
  }),
  z.object({
    intent: z.literal("move"),
    instanceId: uuid,
    direction: z.enum(["up", "down"], { message: "Invalid direction." }),
  }),
]);

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const url = new URL(request.url);
  const laneParam = url.searchParams.get("lane");
  const lane: "draft" | "stock" | "ingredients" =
    laneParam === "stock"
      ? "stock"
      : laneParam === "ingredients"
        ? "ingredients"
        : "draft";

  const data = await loadKitchen(ctx.flat.id);
  return {
    lane,
    draft: data.draft,
    stock: data.stock,
    members: data.members,
    csrfToken: csrfTokenForSession(ctx.session.id),
  };
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);
  const form = await request.formData();
  const parsed = ActionSchema.safeParse(formDataToObject(form));
  if (!parsed.success) {
    return { error: firstMessage(parsed.error) };
  }
  const action = parsed.data;

  if (action.intent === "remove-from-draft") {
    await db()
      .delete(recipeInstances)
      .where(
        and(
          eq(recipeInstances.id, action.instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true };
  }

  if (action.intent === "update-quantity") {
    await db()
      .update(recipeInstances)
      .set({ targetQuantity: action.targetQuantity })
      .where(
        and(
          eq(recipeInstances.id, action.instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true };
  }

  if (action.intent === "set-cook") {
    const cookId: string | null = action.cookId === "" ? null : action.cookId;
    if (cookId !== null) {
      const member = await db()
        .select({ userId: flatMembers.userId })
        .from(flatMembers)
        .where(
          and(eq(flatMembers.flatId, ctx.flat.id), eq(flatMembers.userId, cookId)),
        )
        .limit(1);
      if (member.length === 0) return { error: "Cook is not in this flat." };
    }
    await db()
      .update(recipeInstances)
      .set({ designatedCookId: cookId })
      .where(
        and(
          eq(recipeInstances.id, action.instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.cookedAt),
        ),
      );
    return { ok: true };
  }

  if (action.intent === "set-note") {
    const trimmed = action.note.trim();
    const value: string | null = trimmed.length === 0 ? null : trimmed;
    // Notes are editable in BOTH draft and in-stock (not after cooking).
    await db()
      .update(recipeInstances)
      .set({ note: value })
      .where(
        and(
          eq(recipeInstances.id, action.instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.cookedAt),
        ),
      );
    return { ok: true };
  }

  if (action.intent === "reorder") {
    const { lane, instanceIds: ids } = action;
    const laneCond =
      lane === "draft"
        ? isNull(recipeInstances.finalisedAt)
        : and(
            isNotNull(recipeInstances.finalisedAt),
            isNull(recipeInstances.cookedAt),
          );

    await db().transaction(async (tx) => {
      const rows = await tx
        .select({
          id: recipeInstances.id,
          position: recipeInstances.position,
        })
        .from(recipeInstances)
        .where(and(eq(recipeInstances.flatId, ctx.flat.id), laneCond));
      const existing = new Map(rows.map((r) => [r.id, r.position]));
      if (rows.length !== ids.length || !ids.every((id) => existing.has(id))) {
        // Lane changed under us — bail without writing.
        return;
      }
      const sorted = [...existing.values()].sort((a, b) => a - b);

      // 2-phase: park everything in negative space, then assign the
      // new positions. Dodges the partial unique on (flat_id, position).
      for (const id of ids) {
        const cur = existing.get(id)!;
        await tx
          .update(recipeInstances)
          .set({ position: -1 - cur })
          .where(eq(recipeInstances.id, id));
      }
      for (let i = 0; i < ids.length; i++) {
        await tx
          .update(recipeInstances)
          .set({ position: sorted[i] })
          .where(eq(recipeInstances.id, ids[i]));
      }
    });
    return { ok: true };
  }

  if (action.intent === "finalise") {
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
    // Best-effort: snapshot the deduped shopping list for the handoff
    // page. Never let an LLM hiccup fail the finalise itself — the
    // snapshot function persists an all-singletons fallback on error.
    try {
      await snapshotDedupForFlat(ctx.flat.id);
    } catch (err) {
      console.warn("[finalise] dedup snapshot failed:", err);
    }
    return redirect(`/h/${ctx.flat.id}`);
  }

  if (action.intent === "mark-cooked") {
    const updated = await db()
      .update(recipeInstances)
      .set({ cookedAt: new Date(), cookedBy: ctx.user.id })
      .where(
        and(
          eq(recipeInstances.id, action.instanceId),
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

  // move
  const { instanceId, direction } = action;
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

export default function Kitchen({ loaderData }: Route.ComponentProps) {
  const { lane, draft, stock, csrfToken, members } = loaderData;
  const navigate = useNavigate();

  // Cooked history — lazy-loaded in pages of 5.
  const historyFetcher = useFetcher<{ entries: HistoryEntry[]; hasMore: boolean }>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyStarted, setHistoryStarted] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const isLoadingHistory = historyFetcher.state !== "idle";

  // Append freshly loaded pages to the accumulated list.
  useEffect(() => {
    const data = historyFetcher.data;
    if (!data) return;
    setHistoryLoaded(true);
    if (data.entries.length === 0) return;
    setHistory((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const fresh = data.entries.filter((e) => !existingIds.has(e.id));
      if (fresh.length === 0) return prev;
      return [...prev, ...fresh];
    });
    // Advance by PAGE_SIZE (when hasMore=true, exactly PAGE_SIZE entries are
    // returned; when hasMore=false, no further load will be triggered).
    setHistoryOffset((prev) => prev + HISTORY_PAGE_SIZE);
  }, [historyFetcher.data]);

  const loadHistory = (offset: number) => {
    historyFetcher.load(`/kitchen/history?offset=${offset}`);
  };

  const handleShowHistory = () => {
    setHistoryStarted(true);
    loadHistory(historyOffset);
  };

  const handleLoadMore = () => {
    loadHistory(historyOffset);
  };

  const hasMore = historyFetcher.data?.hasMore ?? true;

  return (
    <Container size="sm" py="md">
      <Stack gap="md">
        <SegmentedControl
          value={lane}
          onChange={(v) =>
            navigate(
              v === "stock"
                ? "?lane=stock"
                : v === "ingredients"
                  ? "?lane=ingredients"
                  : "?lane=draft",
            )
          }
          aria-label="Kitchen lane"
          data={[
            {
              value: "draft",
              label: (
                <>
                  Draft <Text span c="dimmed" inherit>{draft.length}</Text>
                </>
              ),
            },
            {
              value: "stock",
              label: (
                <>
                  In stock <Text span c="dimmed" inherit>{stock.length}</Text>
                </>
              ),
            },
            {
              value: "ingredients",
              label: "Ingredients",
            },
          ]}
        />

        {lane === "draft" ? (
          draft.length === 0 ? (
            <Text c="dimmed">
              Draft is empty — add recipes from the{" "}
              <Anchor component={Link} to="/" prefetch="intent">collection</Anchor>.
            </Text>
          ) : (
            <Stack gap="xs">
              <SortableLane
                lane="draft"
                entries={draft}
                members={members}
                csrfToken={csrfToken}
              />
              <FinaliseButton
                csrfToken={csrfToken}
                draft={draft}
                stockCount={stock.length}
              />
            </Stack>
          )
        ) : lane === "stock" ? (
          <Stack gap="md">
            {stock.length === 0 ? (
              <Text c="dimmed">
                Nothing in stock yet — finalise the draft to start cooking.
              </Text>
            ) : (
              <SortableLane
                lane="stock"
                entries={stock}
                members={members}
                csrfToken={csrfToken}
              />
            )}

            {historyStarted && history.length > 0 && (
              <>
                <Divider label="Gekochte Rezepte" labelPosition="center" />
                <Stack gap="xs">
                  {history.map((entry) => (
                    <HistoryCard key={entry.id} entry={entry} />
                  ))}
                </Stack>
              </>
            )}

            <Stack gap="xs" align="center">
              {!historyStarted ? (
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={handleShowHistory}
                  loading={isLoadingHistory}
                  aria-label="Show cooking history"
                >
                  Verlauf anzeigen
                </Button>
              ) : !historyLoaded || hasMore ? (
                // `!historyLoaded` prevents a one-frame flash of the empty-state
                // message between when the fetcher data arrives and when the
                // useEffect runs to append the entries to `history`.
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={handleLoadMore}
                  loading={isLoadingHistory}
                  aria-label="Load more history"
                >
                  Mehr anzeigen
                </Button>
              ) : history.length > 0 ? (
                <Text size="xs" c="dimmed">Kein weiterer Verlauf</Text>
              ) : (
                <Text size="xs" c="dimmed">Noch keine gekochten Rezepte</Text>
              )}
            </Stack>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Title order={4}>Planned ingredients</Title>
            <PlannedIngredients stock={stock} />
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
