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
import { useDebouncedValue } from "@mantine/hooks";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Link, redirect, useFetcher, useNavigate } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/kitchen";
import type { loader as combinedLoader } from "./kitchen.combined";
import type { loader as combinedSearchLoader } from "./kitchen.combined.search";
import { db } from "../db/client";
import { recipeInstances } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { loadKitchen } from "../lib/kitchen-data";
import {
  markCooked,
  moveInstance,
  removeFromDraft,
  reorderLane,
  setCook,
  setNote,
  setPortions,
} from "../lib/kitchen";
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
    await removeFromDraft({
      flatId: ctx.flat.id,
      instanceId: action.instanceId,
    });
    return { ok: true };
  }

  if (action.intent === "update-quantity") {
    await setPortions({
      flatId: ctx.flat.id,
      instanceId: action.instanceId,
      portions: action.targetQuantity,
    });
    return { ok: true };
  }

  if (action.intent === "set-cook") {
    const cookId: string | null = action.cookId === "" ? null : action.cookId;
    const result = await setCook({
      flatId: ctx.flat.id,
      instanceId: action.instanceId,
      cookId,
    });
    if (!result.ok) return { error: result.error };
    return { ok: true };
  }

  if (action.intent === "set-note") {
    await setNote({
      flatId: ctx.flat.id,
      instanceId: action.instanceId,
      note: action.note,
    });
    return { ok: true };
  }

  if (action.intent === "reorder") {
    // Soft: lane races bail without writing (ignore mismatch error).
    await reorderLane({
      flatId: ctx.flat.id,
      lane: action.lane,
      instanceIds: action.instanceIds,
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
    const result = await markCooked({
      flatId: ctx.flat.id,
      userId: ctx.user.id,
      instanceId: action.instanceId,
    });
    if (!result.ok) return { error: result.error };
    return { ok: true };
  }

  const result = await moveInstance({
    flatId: ctx.flat.id,
    instanceId: action.instanceId,
    direction: action.direction,
  });
  if (!result.ok) return { error: result.error };
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
 * Mobile "Ingredients" tab body. Fetches `/kitchen/combined` on mount and runs
 * embedding dedup over the current in-stock set. Shows a spinner until it
 * resolves. Filter icon expands an input; after debounce the query hits
 * `/kitchen/combined/search` (Postgres FTS on ingredient items + recipe
 * names). Desktop Planned ingredients uses the sidebar modal and browser
 * find instead.
 */
function IngredientsLane() {
  const listFetcher = useFetcher<typeof combinedLoader>();
  const searchFetcher = useFetcher<typeof combinedSearchLoader>();
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (listFetcher.state === "idle" && listFetcher.data === undefined) {
      listFetcher.load("/kitchen/combined");
    }
  }, [listFetcher]);

  useEffect(() => {
    if (filterOpen) filterInputRef.current?.focus();
  }, [filterOpen]);

  const settledQ = debouncedQuery.trim();
  useEffect(() => {
    if (settledQ === "") return;
    searchFetcher.load(
      `/kitchen/combined/search?q=${encodeURIComponent(settledQ)}`,
    );
    // searchFetcher identity changes every render; only re-run on settledQ.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledQ]);

  const list = listFetcher.data;
  if (list === undefined) {
    return (
      <Center py="xl">
        <Loader aria-label="Computing planned ingredients" />
      </Center>
    );
  }

  const stockEmpty = list.combinedGroups.length === 0;
  const filtering = settledQ !== "";
  const searchFresh =
    searchFetcher.state === "idle" &&
    searchFetcher.data !== undefined &&
    searchFetcher.data.q === settledQ;
  const searchPending = filtering && !searchFresh;
  const display =
    filtering && searchFresh && searchFetcher.data
      ? searchFetcher.data
      : list;
  const groups = display.combinedGroups;

  return (
    <Stack gap="xs" data-testid="planned-ingredients-lane">
      <Group
        justify="space-between"
        align="center"
        wrap="nowrap"
        gap="xs"
        style={{ position: "relative", minHeight: 28 }}
      >
        {/*
          Closed: title + icon. Open: input expands left from the icon over
          the title (same row). Input stays mounted so width/opacity can
          animate both ways; autofocus on open.
        */}
        <Title
          order={2}
          size="h4"
          style={{
            flex: 1,
            minWidth: 0,
            opacity: filterOpen ? 0 : 1,
            transition: "opacity 150ms ease",
            pointerEvents: filterOpen ? "none" : undefined,
          }}
        >
          Planned ingredients
        </Title>
        {!stockEmpty && (
          <ActionIcon
            variant="subtle"
            size="compact-sm"
            aria-label="Filter ingredients"
            aria-expanded={filterOpen}
            style={{ flexShrink: 0, zIndex: 2 }}
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
        {!stockEmpty && (
          <div
            aria-hidden={!filterOpen}
            style={{
              position: "absolute",
              left: 0,
              right: 36,
              top: "50%",
              zIndex: 1,
              transformOrigin: "right center",
              transform: filterOpen
                ? "translateY(-50%) scaleX(1)"
                : "translateY(-50%) scaleX(0)",
              opacity: filterOpen ? 1 : 0,
              transition: "transform 200ms ease, opacity 150ms ease",
              pointerEvents: filterOpen ? "auto" : "none",
            }}
          >
            <TextInput
              ref={filterInputRef}
              type="search"
              placeholder="Filter…"
              aria-label="Filter planned ingredients"
              value={query}
              size="xs"
              tabIndex={filterOpen ? 0 : -1}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onBlur={() => {
                if (query.trim() === "") setFilterOpen(false);
              }}
              styles={{ root: { width: "100%" } }}
            />
          </div>
        )}
      </Group>

      {stockEmpty ? (
        <Text c="dimmed">
          No planned ingredients — finalise the draft to start cooking.
        </Text>
      ) : searchPending ? (
        <Center py="md">
          <Loader size="sm" aria-label="Filtering planned ingredients" />
        </Center>
      ) : groups.length === 0 ? (
        <Text c="dimmed" data-testid="ingredients-filter-empty">
          No matches
        </Text>
      ) : (
        <CombinedList
          combinedGroups={groups}
          rejectedIds={display.rejectedIds}
          snapshotFresh={display.snapshotFresh}
          showSingletonSource
        />
      )}
    </Stack>
  );
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
