import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { useDebouncedValue } from "@mantine/hooks";
import type { DedupGroup } from "../db/schema";
import type { CombinedList } from "../lib/combined-list";
import type { loader as combinedLoader } from "../routes/kitchen.combined";
import type { loader as combinedSearchLoader } from "../routes/kitchen.combined.search";

/**
 * On-demand planned-ingredients list plus the debounced
 * `/kitchen/combined/search` query. Shared by the mobile Ingredients lane
 * and the desktop sidebar modal so both ignore stale responses the same way.
 * Loads the full list once on mount — mount the hook only while the surface
 * is actually open. While a query is in flight the previous rows stay
 * visible; callers show the spinner in the search field instead.
 */
export function usePlannedIngredientSearch(): {
  query: string;
  setQuery: (query: string) => void;
  loading: boolean;
  stockEmpty: boolean;
  searchPending: boolean;
  groups: DedupGroup[];
  rejectedIds: string[];
  snapshotFresh: boolean;
} {
  const listFetcher = useFetcher<typeof combinedLoader>();
  const searchFetcher = useFetcher<typeof combinedSearchLoader>();
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 300);
  // Last list we actually painted. Held while the next search is in flight
  // so the rows don't swap back to the full list or disappear.
  const [shown, setShown] = useState<CombinedList | undefined>(undefined);

  useEffect(() => {
    if (listFetcher.state === "idle" && listFetcher.data === undefined) {
      listFetcher.load("/kitchen/combined");
    }
  }, [listFetcher]);

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
  const filtering = settledQ !== "";
  const searchFresh =
    searchFetcher.state === "idle" &&
    searchFetcher.data !== undefined &&
    searchFetcher.data.q === settledQ;
  const searchPending = filtering && !searchFresh;
  const stable: CombinedList | undefined = !list
    ? undefined
    : !filtering
      ? list
      : searchFresh && searchFetcher.data
        ? searchFetcher.data
        : undefined;
  if (stable && stable !== shown) setShown(stable);
  const display = stable ?? shown;

  return {
    query,
    setQuery,
    loading: list === undefined,
    stockEmpty: list !== undefined && list.combinedGroups.length === 0,
    searchPending,
    groups: display?.combinedGroups ?? [],
    rejectedIds: display?.rejectedIds ?? [],
    snapshotFresh: display?.snapshotFresh ?? true,
  };
}
