# Kptncook Import UI Test Plan

## Application Overview

The recipe import modal lets users paste a kptncook share link or id, preview normalized recipe data in the standard form, and recover cleanly from invalid import input.

## Test Scenarios

### 1. Kptncook Import Modal

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. ui-paste-share-url-form-prefilled-save-creates-the-recipe

**File:** `tests/kptncook-import-ui.spec.ts`

**Steps:**
  1. With kptncook share/search/images HTTP mocks enabled, log in and open `/recipes/new`.
  2. Click `Import recipe`.
    - expect: The `Import a recipe` heading is visible.
  3. Paste the mocked kptncook share URL and click `Import`.
    - expect: The import modal heading becomes hidden.
    - expect: The Name field is `Zimtschnecken`.
    - expect: The Source URL field is the canonical mocked kptncook share URL.
    - expect: Ingredient rows are prefilled as `250 g Mehl`, `150 ml Milch`, and `2 Eier`.
    - expect: Steps include `Teig anrühren`, `Zimt-Zucker`, and `180 °C`.
    - expect: The imported photo preview is visible.
  4. Click `Save recipe`.
    - expect: The browser lands on a recipe detail URL.
    - expect: The detail heading is `Zimtschnecken`.
    - expect: The detail view shows `250 g Mehl`, `150 ml Milch`, and `2 Eier`.
    - expect: A recipe image is visible on the detail view.

#### 1.2. ui-bogus-input-modal-shows-error-and-stays-open

**File:** `tests/kptncook-import-ui.spec.ts`

**Steps:**
  1. With kptncook mocks enabled, log in, open `/recipes/new`, and click `Import recipe`.
  2. Enter `nope-not-an-id` and click `Import`.
    - expect: An alert mentions kptncook.
    - expect: The `Import a recipe` modal heading remains visible.
