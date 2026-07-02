# Planned Ingredients Test Plan

## Application Overview

The Ingredients lane summarizes ingredient needs from in-stock recipes, giving flat members a shopping-oriented view that stays empty until draft recipes are finalised. It reuses the shared combined-list rendering (the same LLM dedup snapshot shown on the handoff page), so duplicate ingredients across recipes are merged into a single summed row.

The kitchen surfaces (mobile `/kitchen?lane=ingredients` tab and the desktop sidebar "Planned ingredients" modal) render the combined list **read-only** — a plain shopping summary with no split / unsplit / regenerate affordances (those live only on the handoff page). The combined-list data is loaded deferred, so the tab/modal shows a spinner while it resolves. The list is re-merged (a fresh LLM dedup snapshot) whenever the in-stock set changes through a first-class kitchen action — Finalise, the handoff page's Regenerate, and **marking a recipe cooked** (cooking drops the recipe from the not-yet-cooked set, so the snapshot is refreshed best-effort to keep the summary merged over what's still to cook; this resets any manual splits). Editing a recipe's ingredients without re-finalising can still leave the snapshot stale, in which case the read-only surfaces fall back to an unmerged list.

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
