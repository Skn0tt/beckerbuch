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
