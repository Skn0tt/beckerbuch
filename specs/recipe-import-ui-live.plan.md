# Generic Recipe Import UI Live Test Plan

## Application Overview

The generic import modal fetches real schema.org recipe pages, prefills the recipe form with parsed data, imports a cover image, and saves the result as a normal recipe.

## Test Scenarios

### 1. Live URL Import Modal

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. paste-recipe-url-form-prefilled-save-creates-the-recipe

**File:** `tests/recipe-import-ui-live.spec.ts`

**Steps:**
  1. Log in, open `/recipes/new`, and click `Import recipe`.
    - expect: The `Import a recipe` heading is visible.
  2. Paste `https://www.loveandlemons.com/banana-bread/` and click `Import`.
    - expect: The import modal closes.
    - expect: The Name field contains `banana bread`.
    - expect: The Source URL field contains `loveandlemons.com`.
    - expect: The first ingredient item field is not empty.
    - expect: The Steps field is not empty.
    - expect: A current-photo preview thumbnail is visible.
  3. Click `Save recipe`.
    - expect: The browser lands on a recipe detail URL.
    - expect: A heading containing `banana bread` is visible.

#### 1.2. import-bbc-good-food-baked-ratatouille-prefills-exact-ingredients

**File:** `tests/recipe-import-ui-live.spec.ts`

Asserts the import modal extracts every ingredient from `https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese` into the recipe form with the exact amount, unit, and item — not just sanity counts. Catches regressions where unit detection drops `tbsp`/`tsp`/`ml`/`g`, where unitless counts (e.g. "2 red onions") get a spurious unit, or where the "For the cheese sauce" subsection is skipped.

**Steps:**
  1. Log in, open `/recipes/new`, and click `Import recipe`.
    - expect: The `Import a recipe` heading is visible.
  2. Paste `https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese` and click `Import`.
    - expect: The import modal closes.
    - expect: The Name field contains `ratatouille`.
    - expect: The Source URL field contains `bbcgoodfood.com`.
    - expect: The ingredient rows in the form contain exactly the following 15 entries, in source order, each with the given amount, unit, and item. Preparation notes from the source (e.g. "chopped", "finely grated") stay attached to the item rather than being silently dropped:
      1. `{ amount: "4", unit: "tbsp", item: "olive oil" }`
      2. `{ amount: "2", unit: "", item: "red onions chopped" }`
      3. `{ amount: "2", unit: "", item: "garlic cloves finely chopped" }`
      4. `{ amount: "2", unit: "", item: "aubergines diced" }`
      5. `{ amount: "2", unit: "", item: "red peppers seeded and diced" }`
      6. `{ amount: "1", unit: "tsp", item: "smoked paprika" }`
      7. `{ amount: "2", unit: "tbsp", item: "balsamic vinegar" }`
      8. `{ amount: "1", unit: "tsp", item: "soy sauce" }`
      9. `{ amount: "500", unit: "ml", item: "passata" }`
      10. `{ amount: "200", unit: "g", item: "young goat's cheese" }`
      11. `{ amount: "4", unit: "", item: "courgettes (a mixture of green and yellow looks nice), thinly sliced" }`
      12. `{ amount: "400", unit: "ml", item: "milk" }`
      13. `{ amount: "50", unit: "g", item: "unsalted butter" }`
      14. `{ amount: "50", unit: "g", item: "plain flour" }`
      15. `{ amount: "80", unit: "g", item: "parmesan or vegetarian alternative, finely grated" }`
    - expect: A trailing 16th blank row is present (UI affordance for adding new ingredients) but the 15 source entries are not duplicated between the main list and the "For the cheese sauce" subsection.
    - expect: The Steps field contains 4 method steps.
    - expect: A current-photo preview thumbnail is visible.
  3. Click `Save recipe`.
    - expect: The browser lands on a recipe detail URL.
    - expect: A heading containing `ratatouille` is visible.
