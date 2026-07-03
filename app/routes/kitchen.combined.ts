import type { Route } from "./+types/kitchen.combined";
import { requireFlatMember } from "../auth/require";
import { loadCombinedList, type CombinedList } from "../lib/combined-list";

/**
 * On-demand resource route for the kitchen "Planned ingredients" combined list.
 *
 * Both kitchen surfaces (the mobile `/kitchen?lane=ingredients` tab and the
 * desktop sidebar modal) fetch this via `useFetcher().load("/kitchen/combined")`
 * when the list is actually viewed. Fetchers are never prefetched on hover and
 * this route isn't part of any page's loader chain, so viewing the list is the
 * one deliberate place we let a READ lazily trigger the LLM dedup re-merge
 * (`recomputeIfStale`). That keeps the view merged over what's still to cook
 * without a stray hover or an unrelated layout revalidation firing the LLM.
 */
export async function loader({
  request,
}: Route.LoaderArgs): Promise<CombinedList> {
  const ctx = await requireFlatMember(request);
  return loadCombinedList(ctx.flat.id, { recomputeIfStale: true });
}
