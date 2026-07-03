/**
 * Shared computation of the "Combined list" (deduped shopping list) that is
 * rendered both on the handoff page (`/h/$flatId`) and in the kitchen's
 * "Planned ingredients" view.
 *
 * The source of truth is the dedup snapshot persisted on the `flats` row
 * (written at Finalise / Regenerate — see lib/dedup-snapshot.ts). If that
 * snapshot is missing or stale relative to the current in-stock ingredients,
 * we fall back to an all-singletons list and flag it as stale so the caller
 * can offer a Regenerate affordance.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  flats,
  ingredients,
  recipeInstances,
  recipes,
  type DedupGroup,
} from "../db/schema";
import { formatIngredient } from "./scale";
import { hashInput, type DedupInput } from "./dedup";
import { buildDedupInputFromData, snapshotDedupForFlat } from "./dedup-snapshot";

export type CombinedList = {
  combinedGroups: DedupGroup[];
  snapshotFresh: boolean;
  rejectedIds: string[];
};

type FlatDedupFields = {
  dedupGroups: DedupGroup[] | null;
  dedupInputHash: string | null;
  dedupRejectedGroupIds: string[] | null;
};

/**
 * Pure-ish combiner for callers that have already built the current dedup
 * input (e.g. the handoff loader, which needs the same rows for other
 * sections). Hashes the input to decide snapshot freshness.
 */
export async function computeCombinedList(
  flat: FlatDedupFields,
  currentInput: DedupInput,
): Promise<CombinedList> {
  const currentHash = await hashInput(currentInput);

  const snapshotFresh =
    flat.dedupGroups !== null &&
    flat.dedupInputHash !== null &&
    flat.dedupInputHash === currentHash;

  const rejectedIds = flat.dedupRejectedGroupIds ?? [];

  // Render the snapshot groups when fresh, otherwise an all-singletons
  // fallback derived from the current input.
  const combinedGroups: DedupGroup[] = snapshotFresh
    ? (flat.dedupGroups ?? [])
    : currentInput.items.map((it) => {
        const displayText = formatIngredient(
          { amount: it.amount, unit: it.unit, item: it.item },
          1,
        );
        return {
          id: it.id,
          item: it.item,
          unit: it.unit,
          amount: it.amount,
          displayText,
          sources: [
            { id: it.id, displayText, recipeName: it.recipeName },
          ],
        };
      });

  // Merged groups first so the dedup wins are visible; stable within a tier.
  combinedGroups.sort((a, b) => {
    const aMerged = a.sources.length > 1 ? 1 : 0;
    const bMerged = b.sources.length > 1 ? 1 : 0;
    return bMerged - aMerged;
  });

  return { combinedGroups, snapshotFresh, rejectedIds };
}

/**
 * Loads the combined list for a flat from scratch: reads the persisted dedup
 * snapshot and the current latest-finalised in-stock ingredients, then
 * combines them. Used by callers that don't already have the in-stock rows
 * loaded with ingredient row ids (the kitchen views).
 *
 * By default this is a read-only snapshot read — it never triggers the LLM
 * dedup. When the snapshot is stale (the shopping list changed since finalise)
 * the result is flagged `snapshotFresh: false` and rendered as an
 * all-singletons fallback.
 *
 * Pass `{ recomputeIfStale: true }` to let a stale read lazily re-run the LLM
 * dedup, persist the fresh snapshot, and return the merged result. This writes,
 * so it must only be invoked from the on-demand resource route
 * (`/kitchen/combined`), which is fetched via `useFetcher().load()` when a
 * kitchen surface is actually viewed and is therefore never prefetched on hover
 * nor tied to unrelated layout revalidation.
 */
export async function loadCombinedList(
  flatId: string,
  opts?: { recomputeIfStale?: boolean },
): Promise<CombinedList> {
  const readFlat = () =>
    db()
      .select({
        dedupGroups: flats.dedupGroups,
        dedupInputHash: flats.dedupInputHash,
        dedupRejectedGroupIds: flats.dedupRejectedGroupIds,
      })
      .from(flats)
      .where(eq(flats.id, flatId))
      .limit(1);

  const [flat] = await readFlat();

  if (!flat) {
    return { combinedGroups: [], snapshotFresh: false, rejectedIds: [] };
  }

  // Latest-finalised, not-yet-cooked recipe instances — the same set the
  // dedup snapshot is computed over (see lib/dedup-snapshot.ts).
  const latestFinalisedSubquery = sql<Date>`(
    select max(${recipeInstances.finalisedAt})
    from ${recipeInstances}
    where ${recipeInstances.flatId} = ${flatId}
  )`;
  const rows = await db()
    .select({
      recipeId: recipes.id,
      recipeName: recipes.name,
      baseQuantity: recipes.baseQuantity,
      targetQuantity: recipeInstances.targetQuantity,
    })
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, flatId),
        sql`${recipeInstances.finalisedAt} = ${latestFinalisedSubquery}`,
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  const recipeIds = rows.map((r) => r.recipeId);
  const allIngs =
    recipeIds.length === 0
      ? []
      : await db()
          .select()
          .from(ingredients)
          .where(inArray(ingredients.recipeId, recipeIds))
          .orderBy(asc(ingredients.position));

  const currentInput = buildDedupInputFromData(rows, allIngs);
  let result = await computeCombinedList(flat, currentInput);

  // Lazy on-read re-merge. When a kitchen surface actually views the list and
  // the snapshot is stale (e.g. a recipe was cooked, shrinking the in-stock
  // set), run the LLM dedup once, persist it, and recombine so the view is
  // merged over what's still to cook. Best-effort: on any failure we keep the
  // all-singletons fallback rather than blocking the read.
  if (
    opts?.recomputeIfStale &&
    !result.snapshotFresh &&
    currentInput.items.length > 0
  ) {
    try {
      await snapshotDedupForFlat(flatId);
      const [refreshed] = await readFlat();
      if (refreshed) {
        result = await computeCombinedList(refreshed, currentInput);
      }
    } catch (err) {
      console.warn("[combined-list] recompute-on-read failed:", err);
    }
  }

  return result;
}
