# Planned Ingredients Test Plan

## Application Overview

The Ingredients lane summarizes ingredient needs from in-stock recipes, giving flat members a shopping-oriented view that stays empty until draft recipes are finalised.

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
