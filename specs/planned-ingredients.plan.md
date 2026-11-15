# Planned Ingredients Test Plan

## Application Overview

The Ingredients lane summarizes ingredient needs from **every recipe currently in stock** (finalised, not yet cooked) — the same lane as the kitchen stock list — so flat members can see what is still spoken for. It stays empty until draft recipes are finalised. It reuses the shared combined-list rendering, so duplicate ingredients across recipes collapse to one row. Crucially, it shows all in-stock recipes regardless of which finalise batch they belong to: finalising a new draft while older recipes are still uncooked never hides the older ones.

This is a deliberately different data source from the handoff / shopping page (`/h/$flatId`), which scopes to the **latest finalise batch only** — the trip you're about to shop for — and renders the persisted dedup snapshot on the `flats` row so manual split / unsplit edits survive. The Ingredients lane shares none of that snapshot machinery.

A merged row is titled with the ingredient name only. Each recipe's amount stays on the source line underneath, whether or not those amounts can be added (`300 g tomato` and `300 g tomatos` under `tomato`; `200 g flour` and `2 cups flour` under `flour`). The handoff page still sums compatible units into a buyable headline and splits incompatible units into separate rows.

The kitchen surfaces (mobile `/kitchen?lane=ingredients` tab and the desktop sidebar "Planned ingredients" modal) render the combined list **read-only** — a plain summary of what is still spoken for, with no split / unsplit / regenerate affordances (those live only on the handoff page). Both surfaces load the combined list on demand from a dedicated resource route (`/kitchen/combined`, fetched via `useFetcher().load()` when the tab is opened / the modal opens), showing a spinner while it resolves. That route is never part of a page's loader chain and is never reached from a `<Link>`, so it is never prefetched on hover. Both surfaces also search through `/kitchen/combined/search`: mobile expands a filter over the heading, and the desktop modal has a search field at the top of the dialog.

Because the view is read-only it holds **no snapshot and performs no writes**. Every read clusters the current in-stock ingredients by embedding similarity on the fly (embeddings are cached in `ingredient_embeddings`, so this is a couple of reads plus in-memory clustering — no LLM call and no snapshot to go stale). This means re-merging happens automatically: cook a recipe and the next read simply clusters over the smaller in-stock set. Clustering is best-effort — on any embedding failure the surface falls back to an unmerged all-singletons list. Finalise and the handoff page's Regenerate still write the latest-batch snapshot eagerly as before; that snapshot no longer feeds the Ingredients lane at all.

## Test Scenarios

### 1. Ingredients Lane

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. ingredients-tab-empty-when-nothing-in-stock

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in as the flat user and open `/kitchen?lane=ingredients`.
    - expect: The visible `Ingredients` segment label appears.
    - expect: The `No planned ingredients` empty state is visible.

#### 1.2. ingredients-tab-shows-ingredients-from-in-stock-recipes-with-recipe-name

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in and create a recipe titled `Pasta al limone` with `400 g spaghetti`.
    - expect: Saving lands on a recipe detail URL.
  2. Add the recipe to the draft, open the kitchen, and finalise the draft.
    - expect: The recipe button changes to `✓ In draft` before finalise.
    - expect: Finalising redirects to `/h/<flat id>`.
  3. Open `/kitchen?lane=ingredients`.
    - expect: The `Planned ingredients` heading is visible.
    - expect: `400 g spaghetti` is listed.
    - expect: `Pasta al limone` appears as context for the ingredient.

#### 1.3. ingredients-tab-merges-duplicate-ingredients-into-one-combined-row

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in and create two recipes whose ingredients are trivial variants:
     `Pasta al pomodoro` with `300 g tomato` and `Tomato soup` with
     `300 g tomatos`, adding each to the draft.
  2. Open the kitchen and finalise the draft.
    - expect: Finalising redirects to `/h/<flat id>`.
  3. Open `/kitchen?lane=ingredients`.
    - expect: Exactly one combined row is titled `tomato` (no summed amount).
    - expect: That row is marked merged (`data-merged="true"`).
    - expect: The source lines are `300 g tomato` — Pasta al pomodoro and
      `300 g tomatos` — Tomato soup.

#### 1.4. ingredients-tab-re-merges-over-whats-still-to-cook-after-a-recipe-is-cooked

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in and create three recipes with mergeable tomato ingredients:
     `Pasta al pomodoro` (`300 g tomato`), `Tomato soup` (`300 g tomatos`),
     and `Bruschetta` (`200 g tomato`), adding each to the draft.
  2. Open the kitchen and finalise the draft.
    - expect: Finalising redirects to `/h/<flat id>`.
  3. Open `/kitchen?lane=ingredients`.
    - expect: One row titled `tomato` lists all three recipes, including
      `200 g tomato` — Bruschetta.
  4. Open the `Bruschetta` recipe page and mark it cooked.
    - expect: The `+ Add to draft` affordance returns (it left In stock).
  5. Re-open `/kitchen?lane=ingredients`.
    - expect: Exactly one row is still titled `tomato` and marked merged.
    - expect: `Pasta al pomodoro` and `Tomato soup` appear as sources.
    - expect: The cooked `Bruschetta` and its `200 g tomato` no longer appear.

#### 1.5. ingredients-tab-shows-recipes-from-every-in-stock-finalise-batch

Regression guard for the production bug where the ingredients tab went empty
because it scoped to the latest finalise batch (`MAX(finalised_at)`) instead of
everything currently in stock.

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone` (`400 g spaghetti`), add it to the draft,
     open the kitchen, and finalise (batch A).
    - expect: Finalising redirects to `/h/<flat id>`.
  2. Create `Risotto` (`200 g rice`), add it to a new draft, and finalise again
     while batch A is still uncooked (batch B).
    - expect: Finalising redirects to `/h/<flat id>`.
  3. Open `/kitchen?lane=ingredients`.
    - expect: `400 g spaghetti` and `Pasta al limone` (batch A) are listed.
    - expect: `200 g rice` and `Risotto` (batch B) are listed.

#### 1.6. ingredients-tab-keeps-unit-incompatible-lines-on-one-row

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in and finalise `Pancakes` (`2 cups flour`) and `Bread` (`200 g flour`).
  2. Open `/kitchen?lane=ingredients`.
    - expect: Exactly one combined row, marked merged, titled `flour`
      with no amounts in the title.
    - expect: Both source lines (`200 g flour` — Bread, `2 cups flour` —
      Pancakes) are visible.

#### 1.7. ingredients-tab-lists-rows-alphabetically-by-item-name

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in and create recipes with `tomato`/`tomatos` (merge), `apple`, and
     `zucchini`, finalise them all into stock.
  2. Open `/kitchen?lane=ingredients`.
    - expect: Combined rows appear in A–Z order by item name:
      `apple`, then merged `tomato`, then `zucchini`.
    - expect: The merged tomato row is **not** forced to the top.

#### 1.8. ingredients-tab-filter-icon-narrows-the-list

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in, finalise recipes that yield a merged tomato row and an `apple`
     singleton, open `/kitchen?lane=ingredients`.
  2. Tap the Filter ingredients icon to expand the filter field.
    - expect: Filtering to `apple` shows only the apple row (server FTS,
      debounced).
    - expect: Filtering to a non-match shows `No matches`.
    - expect: Clearing the filter restores both rows.

#### 1.9. ingredients-tab-filter-fts-prefix-match

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in, finalise recipes with `spaghetti` and `apple`, open
     `/kitchen?lane=ingredients`.
  2. Filter to `spag`.
    - expect: Only the spaghetti row remains (prefix `:*` tsquery).

#### 1.10. ingredients-tab-filter-embedding-synonym-fallback

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in, finalise recipes with `möhren` and `apple`, open
     `/kitchen?lane=ingredients`.
  2. Filter to `carotten` (no text match with `möhren`).
    - expect: Only the möhren row remains (meaning / embedding stage).

#### 1.11. ingredients-tab-filter-trigram-typo-fallback

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in, finalise recipes with `avocado` and `apple`, open
     `/kitchen?lane=ingredients`.
  2. Filter to `Avcad` (not an FTS prefix of `avocado`).
    - expect: Only the avocado row remains (text stage via trigram).

#### 1.12. desktop-modal-search-narrows-the-list

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in at a desktop viewport, finalise recipes that yield a merged
     tomato row and an `apple` singleton, and open the collection.
  2. Open the sidebar **Ingredients** button (Planned ingredients modal).
    - expect: A `Search planned ingredients` field is visible above the rows.
    - expect: Both the tomato and apple rows are listed.
  3. Search for `apple`.
    - expect: While the request is in flight the existing rows stay and a
      `Searching planned ingredients` spinner is inside the search field.
    - expect: Only the apple row remains once the request settles.
    - expect: Searching for a non-match shows `No matches`.
    - expect: Clearing the search restores both rows.
