/**
 * The "Combined list" (deduped shopping list) rendered on two surfaces that
 * scope it to *different* sets of recipes:
 *
 *   - The handoff / shopping page (`/h/$flatId`) shows the **latest finalise
 *     batch** — the trip you're about to shop for. It renders the dedup
 *     snapshot persisted on the `flats` row (written at Finalise / Regenerate,
 *     see lib/dedup-snapshot.ts) so manual split/unsplit edits survive, and
 *     falls back to all-singletons + a Regenerate affordance when stale. See
 *     {@link computeCombinedList}.
 *
 *   - The kitchen "Planned ingredients" view shows **everything currently in
 *     stock** (finalised, not yet cooked), regardless of finalise batch — the
 *     same lane as the kitchen stock list. It's read-only (no manual edits),
 *     so it ignores the snapshot and just clusters the current in-stock
 *     ingredients by embedding similarity on the fly. See
 *     {@link loadCombinedList}.
 */
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  ingredients,
  recipeInstances,
  recipes,
  type DedupGroup,
} from "../db/schema";
import { formatIngredient } from "./scale";
import { dedup, hashInput, type DedupInput } from "./dedup";
import { buildDedupInputFromData } from "./dedup-snapshot";

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
 * Loads the combined ("Planned ingredients") list for a flat's kitchen
 * surfaces: every recipe currently **in stock** — finalised and not yet
 * cooked — regardless of which finalise batch it belongs to. This is the same
 * lane the kitchen stock list shows (see lib/kitchen-data.ts), NOT the
 * latest-finalise-batch set the handoff/shopping page uses.
 *
 * The view is read-only (no manual split/unsplit), so it never touches the
 * persisted dedup snapshot on the flat row — that snapshot exists only to
 * preserve manual edits on the handoff page. Here we cluster the current
 * in-stock ingredients by embedding similarity on the fly. Embeddings are
 * cached (see lib/embeddings.ts), so this is a couple of reads plus in-memory
 * clustering, and it never writes. On any embedding failure `dedup` degrades
 * to an all-singletons list.
 */
export async function loadCombinedList(flatId: string): Promise<CombinedList> {
  const rows = await db()
    .select({
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
        eq(recipeInstances.flatId, flatId),
        isNotNull(recipeInstances.finalisedAt),
        isNull(recipeInstances.cookedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));

  if (rows.length === 0) {
    return { combinedGroups: [], snapshotFresh: true, rejectedIds: [] };
  }

  const recipeIds = [...new Set(rows.map((r) => r.recipeId))];
  const allIngs = await db()
    .select()
    .from(ingredients)
    .where(inArray(ingredients.recipeId, recipeIds))
    .orderBy(asc(ingredients.position));

  // Union of ingredients omitted on any in-stock instance; dedup collapses
  // instances by recipeId, so a single set is enough (matches buildDedupInput).
  const omitted = new Set<string>();
  for (const r of rows) for (const id of r.omittedIngredientIds) omitted.add(id);

  const input = buildDedupInputFromData(rows, allIngs, omitted);
  const { groups } = await dedup(input);

  // Merged groups first so the dedup wins are visible; stable within a tier.
  groups.sort((a, b) => {
    const aMerged = a.sources.length > 1 ? 1 : 0;
    const bMerged = b.sources.length > 1 ? 1 : 0;
    return bMerged - aMerged;
  });

  return { combinedGroups: groups, snapshotFresh: true, rejectedIds: [] };
}
