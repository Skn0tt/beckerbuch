# Recipes Test Plan

## Application Overview

Recipe management is the cookbook's core flow: members create, validate, edit, delete, upload photos for, and search recipes while keeping recipe visibility scoped to their flat.

## Test Scenarios

### 1. Creating and Validating Recipes

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. create-a-recipe-see-it-on-home-open-detail-view

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in and click `+ New recipe`.
    - expect: The browser URL is `/recipes/new`.
  2. Fill the form with name `Pasta al limone`, source URL, ingredients `400 g spaghetti`, `2 lemons`, `olive oil, salt, pepper`, and cooking steps, then save.
    - expect: The browser lands on a recipe detail URL.
    - expect: The Draft heading is visible.
    - expect: The `Pasta al limone` heading is visible.
    - expect: The detail view shows all three ingredient lines, the steps, and a source link for `smittenkitchen.com`.
  3. Return home.
    - expect: The browser URL is `/`.
    - expect: A home-card link for `Pasta al limone` is visible.
    - expect: The Draft heading is visible.

#### 1.2. recipe-form-rejects-empty-name-and-missing-ingredients

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in, open the new-recipe form, enter name `Empty test`, leave ingredients blank, and save.
    - expect: An alert says at least one ingredient is required.

#### 1.3. recipe-form-keeps-one-trailing-empty-ingredient-row

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in and open the new-recipe form.
    - expect: There is no `+ Add ingredient` button.
    - expect: `Ingredient 2 item` is not present yet.
    - expect: The first ingredient unit input has `autocapitalize="none"` and `autocorrect="off"`.
  2. Type `flour` into the first ingredient item.
    - expect: A second ingredient item row becomes visible.
  3. Type `water` into the second ingredient item.
    - expect: A third ingredient item row becomes visible.

#### 1.4. rapid-double-click-on-save-creates-only-one-recipe

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in, open the new-recipe form, fill `Double click test` with ingredient `water`, and delay the save request.
  2. Click `Save recipe` twice rapidly.
    - expect: The Save button becomes disabled while submitting.
    - expect: The browser lands on a recipe detail URL.
    - expect: Only one POST reaches the server.
  3. Return home.
    - expect: Exactly one `Double click test` recipe link exists.

### 2. Recipe Isolation and Error Routes

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. recipes-are-scoped-to-the-flat-other-flats-recipe-404

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. In flat A, log in and create `Secret recipe` with ingredient `water`.
    - expect: Saving lands on a recipe detail URL.
  2. Clear cookies, provision and join flat B as `Other Cook`, then open flat A's recipe URL.
    - expect: The response status is 404.

#### 2.2. malformed-uuid-in-r-id-404

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Without using the flat fixture, visit `/r/lol`.
    - expect: The response status is 404.

### 3. Editing, Deleting, and Photos

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 3.1. edit-a-recipe-change-name-ingredient-see-it-on-view-home

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in and create `Pasta al limone` with `400 g spaghetti` and `lemons`.
  2. Click `Edit recipe`.
    - expect: The browser URL ends with `/edit`.
    - expect: The Name field is prefilled with `Pasta al limone`.
    - expect: The first ingredient item is prefilled with `spaghetti`.
  3. Change the name to `Pasta al limone (better)` and the first amount to `450`, then save changes.
    - expect: The edited field values are visible before saving.
    - expect: The browser returns to the recipe detail URL.
    - expect: The heading is `Pasta al limone (better)`.
    - expect: `450 g spaghetti` is visible.
  4. Return home.
    - expect: A link for `Pasta al limone (better)` is visible.
    - expect: No exact `Pasta al limone` link remains.

#### 3.2. delete-a-recipe-back-on-home-recipe-gone

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, open its edit page, accept the browser confirmation, and click `Delete recipe`.
    - expect: The browser returns to `/`.
    - expect: `No recipes yet` is visible.

#### 3.3. deleting-a-recipe-thats-in-the-draft-is-blocked

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, and add it to the draft.
    - expect: The button changes to `✓ In draft`.
  2. Open the edit page, accept the delete confirmation, and click `Delete recipe`.
    - expect: A message says recipes in draft, stock, or cooked history cannot be deleted.
    - expect: The browser remains on the edit URL.
  3. Reopen the recipe detail URL.
    - expect: The `Pasta al limone` heading is still visible.

#### 3.4. upload-a-photo-on-create-see-it-on-view-remove-it-on-edit

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in, open the new-recipe form, fill `Photo recipe` with ingredient `water`, attach a tiny PNG, and save.
    - expect: The browser lands on a recipe detail URL.
    - expect: An image named `Photo recipe` is visible.
    - expect: The browser has loaded the image with natural width greater than zero.
  2. Open the edit page, check `Remove current photo`, and save changes.
    - expect: The browser returns to a recipe detail URL.
    - expect: No image named `Photo recipe` remains.

#### 3.5. rejects-non-image-upload-with-form-error

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in, open the new-recipe form, fill `Bad upload` with ingredient `water`, attach a text file, and save.
    - expect: An alert says uploads must be JPEG, PNG, or WebP.

### 4. Search

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 4.1. search-filters-by-name-ingredient-source-host

**File:** `tests/recipes.spec.ts`

**Steps:**
  1. Log in and create recipes `Pasta al limone`, `Chicken curry`, `Salty noodles`, `Salt crust`, and `Sourdough loaf` with the tested ingredients/source host.
  2. Search for `past` and press Enter.
    - expect: One recipe card is shown.
    - expect: The card contains `Pasta al limone`.
  3. Search for `chicken`.
    - expect: One card is shown.
    - expect: The card contains `Chicken curry`.
  4. Search for `salt` twice.
    - expect: Two cards are shown.
    - expect: The result order is identical across repeated searches.
  5. Search for `kingarthur`.
    - expect: One card is shown.
    - expect: The card contains `Sourdough loaf`.
  6. Search for `nothingmatchesthis`.
    - expect: No cards are shown.
    - expect: A `No recipes match` empty state is visible.
