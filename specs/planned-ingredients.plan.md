# Planned Ingredients Test Plan

## Application Overview

The Ingredients lane summarizes ingredient needs from **every recipe currently in stock** (finalised, not yet cooked) — the same lane as the kitchen stock list — giving flat members a shopping-oriented view that stays empty until draft recipes are finalised. It reuses the shared combined-list rendering, so duplicate ingredients across recipes are merged into a single summed row. Crucially, it shows all in-stock recipes regardless of which finalise batch they belong to: finalising a new draft while older recipes are still uncooked never hides the older ones.

This is a deliberately different data source from the handoff / shopping page (`/h/$flatId`), which scopes to the **latest finalise batch only** — the trip you're about to shop for — and renders the persisted dedup snapshot on the `flats` row so manual split / unsplit edits survive. The Ingredients lane shares none of that snapshot machinery.

The kitchen surfaces (mobile `/kitchen?lane=ingredients` tab and the desktop sidebar "Planned ingredients" modal) render the combined list **read-only** — a plain shopping summary with no split / unsplit / regenerate affordances (those live only on the handoff page). Both surfaces load the combined list on demand from a dedicated resource route (`/kitchen/combined`, fetched via `useFetcher().load()` when the tab is opened / the modal opens), showing a spinner while it resolves. That route is never part of a page's loader chain and is never reached from a `<Link>`, so it is never prefetched on hover.

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
    - expect: Exactly one combined row shows the summed `600 g tomato`.
    - expect: That row is marked merged (`data-merged="true"`).
    - expect: Both `Pasta al pomodoro` and `Tomato soup` appear as sources.

#### 1.4. ingredients-tab-re-merges-over-whats-still-to-cook-after-a-recipe-is-cooked

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in and create three recipes with mergeable tomato ingredients:
     `Pasta al pomodoro` (`300 g tomato`), `Tomato soup` (`300 g tomatos`),
     and `Bruschetta` (`200 g tomato`), adding each to the draft.
  2. Open the kitchen and finalise the draft.
    - expect: Finalising redirects to `/h/<flat id>`.
  3. Open `/kitchen?lane=ingredients`.
    - expect: One combined row shows the summed `800 g tomato`.
  4. Open the `Bruschetta` recipe page and mark it cooked.
    - expect: The `+ Add to draft` affordance returns (it left In stock).
  5. Re-open `/kitchen?lane=ingredients`.
    - expect: Exactly one combined row shows the re-summed `600 g tomato`.
    - expect: That row is still marked merged (`data-merged="true"`).
    - expect: `Pasta al pomodoro` and `Tomato soup` appear as sources.
    - expect: The cooked `Bruschetta` no longer appears.

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

#### 1.6. ingredients-tab-lists-rows-alphabetically-by-item-name

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in and create recipes with `tomato`/`tomatos` (merge), `apple`, and
     `zucchini`, finalise them all into stock.
  2. Open `/kitchen?lane=ingredients`.
    - expect: Combined rows appear in A–Z order by item name:
      `apple`, then merged `tomato`, then `zucchini`.
    - expect: The merged tomato row is **not** forced to the top.

#### 1.7. ingredients-tab-filter-icon-narrows-the-list

**File:** `tests/planned-ingredients.spec.ts`

**Steps:**
  1. Log in, finalise recipes that yield a merged tomato row and an `apple`
     singleton, open `/kitchen?lane=ingredients`.
  2. Tap the Filter ingredients icon to expand the filter field.
    - expect: Filtering to `apple` shows only the apple row.
    - expect: Filtering to a non-match shows `No matches`.
    - expect: Clearing the filter restores both rows.
