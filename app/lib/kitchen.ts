import { and, asc, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import { db } from "../db/client";
import { flatMembers, recipeInstances, recipes } from "../db/schema";

export type KitchenOk<T = object> = { ok: true } & T;
export type KitchenErr = { ok: false; error: string };
export type KitchenResult<T = object> = KitchenOk<T> | KitchenErr;

export type PlanLane = "draft" | "stock";

/** Free-text kitchen notes (draft + in stock). */
export const PLAN_NOTE_MAX = 2000;

async function assertFlatMember(
  flatId: string,
  userId: string,
): Promise<boolean> {
  const member = await db()
    .select({ userId: flatMembers.userId })
    .from(flatMembers)
    .where(and(eq(flatMembers.flatId, flatId), eq(flatMembers.userId, userId)))
    .limit(1);
  return member.length > 0;
}

function validatePortions(portions: number): KitchenErr | null {
  if (!Number.isInteger(portions) || portions < 1 || portions > 1000) {
    return { ok: false, error: "Portions must be between 1 and 1000." };
  }
  return null;
}

/**
 * Normalize a plan note.
 * - `undefined` → leave unchanged (no field)
 * - `null` / blank → clear
 * - otherwise trim + length-check
 */
function normalizeNote(
  note: string | null | undefined,
): KitchenResult<{ value: string | null | undefined }> {
  if (note === undefined) return { ok: true, value: undefined };
  if (note === null || note.trim().length === 0) return { ok: true, value: null };
  const trimmed = note.trim();
  if (trimmed.length > PLAN_NOTE_MAX) {
    return {
      ok: false,
      error: `Note must be at most ${PLAN_NOTE_MAX} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Add a recipe to the draft (one open draft instance per recipe).
 * If already drafted, optionally patch portions / note / cook and return
 * the existing instance id.
 */
export async function addToDraft(opts: {
  flatId: string;
  recipeId: string;
  portions?: number;
  note?: string | null;
  cookId?: string | null;
}): Promise<KitchenResult<{ instanceId: string; created: boolean }>> {
  const { flatId, recipeId } = opts;

  const [recipe] = await db()
    .select({
      id: recipes.id,
      baseQuantity: recipes.baseQuantity,
    })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.flatId, flatId)))
    .limit(1);
  if (!recipe) return { ok: false, error: "Recipe not found." };

  if (opts.cookId != null) {
    if (!(await assertFlatMember(flatId, opts.cookId))) {
      return { ok: false, error: "Cook is not in this flat." };
    }
  }

  if (opts.portions !== undefined) {
    const portionsErr = validatePortions(opts.portions);
    if (portionsErr) return portionsErr;
  }

  const noteNorm = normalizeNote(opts.note);
  if (!noteNorm.ok) return noteNorm;
  const noteValue = noteNorm.value;

  const [existing] = await db()
    .select({ id: recipeInstances.id })
    .from(recipeInstances)
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        eq(recipeInstances.recipeId, recipeId),
        isNull(recipeInstances.finalisedAt),
      ),
    )
    .limit(1);

  if (existing) {
    const patch: {
      targetQuantity?: number;
      note?: string | null;
      designatedCookId?: string | null;
    } = {};
    if (opts.portions !== undefined) patch.targetQuantity = opts.portions;
    if (noteValue !== undefined) patch.note = noteValue;
    if (opts.cookId !== undefined) patch.designatedCookId = opts.cookId;
    if (Object.keys(patch).length > 0) {
      await db()
        .update(recipeInstances)
        .set(patch)
        .where(eq(recipeInstances.id, existing.id));
    }
    return { ok: true, instanceId: existing.id, created: false };
  }

  const portions = opts.portions ?? recipe.baseQuantity;
  const portionsErr = validatePortions(portions);
  if (portionsErr) return portionsErr;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [{ value: nextPos }] = await db()
        .select({
          value: sql<number>`coalesce(${max(recipeInstances.position)}, -1) + 1`,
        })
        .from(recipeInstances)
        .where(
          and(eq(recipeInstances.flatId, flatId), isNull(recipeInstances.finalisedAt)),
        );
      const [inserted] = await db()
        .insert(recipeInstances)
        .values({
          flatId,
          recipeId,
          targetQuantity: portions,
          position: nextPos,
          note: noteValue === undefined ? null : noteValue,
          designatedCookId: opts.cookId === undefined ? null : opts.cookId,
        })
        .returning({ id: recipeInstances.id });
      return { ok: true, instanceId: inserted.id, created: true };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "23505" && attempt < 2) continue;
      throw err;
    }
  }
  return { ok: false, error: "Couldn't add to draft. Please try again." };
}

export async function removeFromDraft(opts: {
  flatId: string;
  instanceId: string;
}): Promise<KitchenResult> {
  const deleted = await db()
    .delete(recipeInstances)
    .where(
      and(
        eq(recipeInstances.id, opts.instanceId),
        eq(recipeInstances.flatId, opts.flatId),
        isNull(recipeInstances.finalisedAt),
      ),
    )
    .returning({ id: recipeInstances.id });
  if (deleted.length === 0) {
    return { ok: false, error: "Not found in draft." };
  }
  return { ok: true };
}

export async function setPortions(opts: {
  flatId: string;
  instanceId: string;
  portions: number;
}): Promise<KitchenResult> {
  const portionsErr = validatePortions(opts.portions);
  if (portionsErr) return portionsErr;
  const updated = await db()
    .update(recipeInstances)
    .set({ targetQuantity: opts.portions })
    .where(
      and(
        eq(recipeInstances.id, opts.instanceId),
        eq(recipeInstances.flatId, opts.flatId),
        isNull(recipeInstances.finalisedAt),
      ),
    )
    .returning({ id: recipeInstances.id });
  if (updated.length === 0) {
    return { ok: false, error: "Portions can only be changed on draft entries." };
  }
  return { ok: true };
}

/** Recipe-detail UI: update draft portions by recipe id. */
export async function setPortionsForRecipeDraft(opts: {
  flatId: string;
  recipeId: string;
  portions: number;
}): Promise<KitchenResult> {
  const portionsErr = validatePortions(opts.portions);
  if (portionsErr) return portionsErr;
  await db()
    .update(recipeInstances)
    .set({ targetQuantity: opts.portions })
    .where(
      and(
        eq(recipeInstances.flatId, opts.flatId),
        eq(recipeInstances.recipeId, opts.recipeId),
        isNull(recipeInstances.finalisedAt),
      ),
    );
  return { ok: true };
}

export async function setCook(opts: {
  flatId: string;
  instanceId: string;
  cookId: string | null;
}): Promise<KitchenResult> {
  if (opts.cookId !== null) {
    if (!(await assertFlatMember(opts.flatId, opts.cookId))) {
      return { ok: false, error: "Cook is not in this flat." };
    }
  }
  const updated = await db()
    .update(recipeInstances)
    .set({ designatedCookId: opts.cookId })
    .where(
      and(
        eq(recipeInstances.id, opts.instanceId),
        eq(recipeInstances.flatId, opts.flatId),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .returning({ id: recipeInstances.id });
  if (updated.length === 0) {
    return { ok: false, error: "Not found or already cooked." };
  }
  return { ok: true };
}

export async function setNote(opts: {
  flatId: string;
  instanceId: string;
  note: string | null;
}): Promise<KitchenResult> {
  const noteNorm = normalizeNote(opts.note);
  if (!noteNorm.ok) return noteNorm;
  // setNote always receives an explicit value (null clears).
  const value = noteNorm.value ?? null;
  const updated = await db()
    .update(recipeInstances)
    .set({ note: value })
    .where(
      and(
        eq(recipeInstances.id, opts.instanceId),
        eq(recipeInstances.flatId, opts.flatId),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .returning({ id: recipeInstances.id });
  if (updated.length === 0) {
    return { ok: false, error: "Not found or already cooked." };
  }
  return { ok: true };
}

export async function reorderLane(opts: {
  flatId: string;
  lane: PlanLane;
  instanceIds: string[];
}): Promise<KitchenResult> {
  const { flatId, lane, instanceIds: ids } = opts;
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "instanceIds must be unique." };
  }

  const laneCond =
    lane === "draft"
      ? isNull(recipeInstances.finalisedAt)
      : and(
          isNotNull(recipeInstances.finalisedAt),
          isNull(recipeInstances.cookedAt),
        );

  let mismatched = false;
  await db().transaction(async (tx) => {
    const rows = await tx
      .select({
        id: recipeInstances.id,
        position: recipeInstances.position,
      })
      .from(recipeInstances)
      .where(and(eq(recipeInstances.flatId, flatId), laneCond));
    const existing = new Map(rows.map((r) => [r.id, r.position]));
    if (rows.length !== ids.length || !ids.every((id) => existing.has(id))) {
      mismatched = true;
      return;
    }
    const sorted = [...existing.values()].sort((a, b) => a - b);

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
  if (mismatched) {
    return { ok: false, error: "Order does not match the current lane." };
  }
  return { ok: true };
}

export async function markCooked(opts: {
  flatId: string;
  userId: string;
  instanceId: string;
}): Promise<KitchenResult> {
  const updated = await db()
    .update(recipeInstances)
    .set({ cookedAt: new Date(), cookedBy: opts.userId })
    .where(
      and(
        eq(recipeInstances.id, opts.instanceId),
        eq(recipeInstances.flatId, opts.flatId),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .returning({ id: recipeInstances.id });
  if (updated.length === 0) {
    return { ok: false, error: "Already cooked or not in stock." };
  }
  return { ok: true };
}

/** Recipe-detail UI: mark the in-stock instance for a recipe as cooked. */
export async function markCookedForRecipe(opts: {
  flatId: string;
  userId: string;
  recipeId: string;
}): Promise<KitchenResult> {
  const [stock] = await db()
    .select({ id: recipeInstances.id })
    .from(recipeInstances)
    .where(
      and(
        eq(recipeInstances.flatId, opts.flatId),
        eq(recipeInstances.recipeId, opts.recipeId),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position))
    .limit(1);
  if (!stock) {
    return { ok: false, error: "Already cooked or not in stock." };
  }
  return markCooked({
    flatId: opts.flatId,
    userId: opts.userId,
    instanceId: stock.id,
  });
}

export async function backToDraft(opts: {
  flatId: string;
  instanceId: string;
}): Promise<KitchenResult> {
  const { flatId, instanceId } = opts;
  const [row] = await db()
    .select({
      id: recipeInstances.id,
      recipeId: recipeInstances.recipeId,
      finalisedAt: recipeInstances.finalisedAt,
      cookedAt: recipeInstances.cookedAt,
    })
    .from(recipeInstances)
    .where(
      and(eq(recipeInstances.id, instanceId), eq(recipeInstances.flatId, flatId)),
    )
    .limit(1);
  if (!row) return { ok: false, error: "Not found." };
  if (row.cookedAt !== null) {
    return { ok: false, error: "Cooked entries can't move back to draft." };
  }
  if (row.finalisedAt === null) {
    return { ok: false, error: "Already in draft." };
  }

  const [existingDraft] = await db()
    .select({ id: recipeInstances.id })
    .from(recipeInstances)
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        eq(recipeInstances.recipeId, row.recipeId),
        isNull(recipeInstances.finalisedAt),
      ),
    )
    .limit(1);
  if (existingDraft) {
    return { ok: false, error: "This recipe is already in your draft." };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const demoted = await db().transaction(async (tx) => {
        const [{ value: nextPos }] = await tx
          .select({
            value: sql<number>`coalesce(${max(recipeInstances.position)}, -1) + 1`,
          })
          .from(recipeInstances)
          .where(
            and(eq(recipeInstances.flatId, flatId), isNull(recipeInstances.finalisedAt)),
          );
        const updated = await tx
          .update(recipeInstances)
          .set({ finalisedAt: null, position: nextPos })
          .where(
            and(
              eq(recipeInstances.id, instanceId),
              eq(recipeInstances.flatId, flatId),
              isNotNull(recipeInstances.finalisedAt),
              isNull(recipeInstances.cookedAt),
            ),
          )
          .returning({ id: recipeInstances.id });
        return updated.length > 0;
      });
      if (!demoted) {
        return { ok: false, error: "This recipe isn't in stock." };
      }
      return { ok: true };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "23505" && attempt < 2) continue;
      throw err;
    }
  }
  return { ok: false, error: "Couldn't move back to draft. Please try again." };
}

/** Recipe-detail UI: demote the in-stock instance for a recipe. */
export async function backToDraftForRecipe(opts: {
  flatId: string;
  recipeId: string;
}): Promise<KitchenResult> {
  const [stock] = await db()
    .select({ id: recipeInstances.id })
    .from(recipeInstances)
    .where(
      and(
        eq(recipeInstances.flatId, opts.flatId),
        eq(recipeInstances.recipeId, opts.recipeId),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position))
    .limit(1);
  if (!stock) {
    return { ok: false, error: "This recipe isn't in stock." };
  }
  return backToDraft({ flatId: opts.flatId, instanceId: stock.id });
}

/** Neighbour swap for keyboard / button reorder in the UI. */
export async function moveInstance(opts: {
  flatId: string;
  instanceId: string;
  direction: "up" | "down";
}): Promise<KitchenResult> {
  const { flatId, instanceId, direction } = opts;
  const rows = await db()
    .select({
      id: recipeInstances.id,
      position: recipeInstances.position,
      finalisedAt: recipeInstances.finalisedAt,
      cookedAt: recipeInstances.cookedAt,
    })
    .from(recipeInstances)
    .where(
      and(eq(recipeInstances.id, instanceId), eq(recipeInstances.flatId, flatId)),
    )
    .limit(1);
  if (rows.length === 0) return { ok: false, error: "Not found." };
  const row = rows[0];
  if (row.cookedAt !== null) return { ok: false, error: "Cooked entries can't move." };
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
        eq(recipeInstances.flatId, flatId),
        laneCond,
        direction === "up"
          ? sql`${recipeInstances.position} < ${row.position}`
          : sql`${recipeInstances.position} > ${row.position}`,
      ),
    )
    .orderBy(direction === "up" ? sql`position desc` : sql`position asc`)
    .limit(1);
  if (neighbours.length === 0) return { ok: true };
  const neighbour = neighbours[0];

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
