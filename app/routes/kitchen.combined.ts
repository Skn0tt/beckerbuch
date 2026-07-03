import type { Route } from "./+types/kitchen.combined";
import { requireFlatMember } from "../auth/require";
import { loadCombinedList, type CombinedList } from "../lib/combined-list";

/**
 * On-demand resource route for the kitchen "Planned ingredients" combined list.
 *
 * Both kitchen surfaces (the mobile `/kitchen?lane=ingredients` tab and the
 * desktop sidebar modal) fetch this via `useFetcher().load("/kitchen/combined")`
 * when the list is actually viewed. It reports everything currently in stock
 * (finalised, not yet cooked) across all finalise batches — the same lane as
 * the kitchen stock list — deduped on the fly by embedding similarity. It's a
 * read-only view, so it holds no snapshot and performs no writes.
 */
export async function loader({
  request,
}: Route.LoaderArgs): Promise<CombinedList> {
  const ctx = await requireFlatMember(request);
  return loadCombinedList(ctx.flat.id);
}
