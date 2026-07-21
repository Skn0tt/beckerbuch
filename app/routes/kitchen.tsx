import {
  ActionIcon,
  Anchor,
  Center,
  Container,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Link, redirect, useFetcher, useNavigate } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/kitchen";
import type { loader as combinedLoader } from "./kitchen.combined";
import { db } from "../db/client";
import { recipeInstances, flatMembers, type DedupGroup } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { loadKitchen } from "../lib/kitchen-data";
import { snapshotDedupForFlat } from "../lib/dedup-snapshot";
import {
  FinaliseButton,
  SortableLane,
} from "../components/kitchen-sidebar";
import { CombinedList } from "../components/combined-list";
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
    flatId: ctx.flat.id,
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
          stock.length === 0 ? (
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
          )
        ) : (
          <IngredientsLane />
        )}
      </Stack>
    </Container>
  );
}

/**
 * Mobile "Ingredients" tab body. Fetches the combined list on demand from the
 * dedicated resource route (never prefetched) so viewing it can lazily re-run
 * embedding dedup over the current in-stock set. Shows a spinner until it
 * resolves. Includes a tucked-away client filter (icon → expand) for scanning
 * long lists on mobile — desktop Planned ingredients uses the sidebar modal
 * and browser find instead.
 */
function IngredientsLane() {
  const fetcher = useFetcher<typeof combinedLoader>();
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data === undefined) {
      fetcher.load("/kitchen/combined");
    }
  }, [fetcher]);

  useEffect(() => {
    if (filterOpen) filterInputRef.current?.focus();
  }, [filterOpen]);

  const combined = fetcher.data;
  if (combined === undefined) {
    return (
      <Center py="xl">
        <Loader aria-label="Computing planned ingredients" />
      </Center>
    );
  }

  const groups = combined.combinedGroups;
  const stockEmpty = groups.length === 0;
  const filtered = stockEmpty ? groups : filterIngredientGroups(groups, query);

  return (
    <Stack gap="xs" data-testid="planned-ingredients-lane">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={2} size="h4">
          Planned ingredients
        </Title>
        {!stockEmpty && (
          <ActionIcon
            variant="subtle"
            size="compact-sm"
            aria-label="Filter ingredients"
            aria-expanded={filterOpen}
            onClick={() => {
              setFilterOpen((open) => {
                if (open && query === "") return false;
                return true;
              });
            }}
          >
            <SearchIcon />
          </ActionIcon>
        )}
      </Group>

      {filterOpen && !stockEmpty && (
        <TextInput
          ref={filterInputRef}
          type="search"
          placeholder="Filter…"
          aria-label="Filter planned ingredients"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onBlur={() => {
            if (query.trim() === "") setFilterOpen(false);
          }}
        />
      )}

      {stockEmpty ? (
        <Text c="dimmed">
          No planned ingredients — finalise the draft to start cooking.
        </Text>
      ) : filtered.length === 0 ? (
        <Text c="dimmed" data-testid="ingredients-filter-empty">
          No matches
        </Text>
      ) : (
        <CombinedList
          combinedGroups={filtered}
          rejectedIds={combined.rejectedIds}
          snapshotFresh={combined.snapshotFresh}
          showSingletonSource
        />
      )}
    </Stack>
  );
}

function filterIngredientGroups(
  groups: DedupGroup[],
  query: string,
): DedupGroup[] {
  const q = query.trim().toLowerCase();
  if (q === "") return groups;
  return groups.filter((g) => {
    if (g.item.toLowerCase().includes(q)) return true;
    if (g.displayText.toLowerCase().includes(q)) return true;
    return g.sources.some((s) => s.recipeName.toLowerCase().includes(q));
  });
}

function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
