import type { Route } from "./+types/kitchen.combined.search";
import { requireFlatMember } from "../auth/require";
import { searchPlannedIngredients } from "../lib/ingredient-search";
import type { CombinedList } from "../lib/combined-list";

export type PlannedIngredientsSearch = CombinedList & { q: string };

/**
 * Debounced FTS filter for the kitchen Planned ingredients lane.
 * Query param `q` is tokenised with the same prefix tsquery as recipe
 * search; empty/missing `q` returns the full in-stock combined list.
 * Echoes `q` so the client can ignore stale responses.
 */
export async function loader({
  request,
}: Route.LoaderArgs): Promise<PlannedIngredientsSearch> {
  const ctx = await requireFlatMember(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const combined = await searchPlannedIngredients(ctx.flat.id, q);
  return { ...combined, q };
}
