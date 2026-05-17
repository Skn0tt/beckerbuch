import {
  Anchor,
  Container,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Link, redirect, useNavigate } from "react-router";
import type { Route } from "./+types/kitchen";
import { db } from "../db/client";
import { recipeInstances, flatMembers } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { loadKitchen } from "../lib/kitchen-data";
import {
  DraftCard,
  FinaliseButton,
  StockCard,
} from "../components/kitchen-sidebar";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const url = new URL(request.url);
  const laneParam = url.searchParams.get("lane");
  const lane: "draft" | "stock" = laneParam === "stock" ? "stock" : "draft";

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
          isNull(recipeInstances.cookedAt),
        ),
      );
    return { ok: true };
  }

  if (intent === "set-note") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    const raw = String(form.get("note") ?? "");
    const trimmed = raw.trim();
    const value: string | null = trimmed.length === 0 ? null : trimmed;
    // Notes are editable in BOTH draft and in-stock (not after cooking).
    await db()
      .update(recipeInstances)
      .set({ note: value })
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.cookedAt),
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

  return { error: "Unknown action." };
}

export default function Kitchen({ loaderData }: Route.ComponentProps) {
  const { lane, draft, stock, csrfToken, members } = loaderData;
  const navigate = useNavigate();
  return (
    <Container size="sm" py="md">
      <Stack gap="md">
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
                members={members}
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
