# Handoff Dedup Test Plan

## Application Overview

The handoff page combines finalised recipe ingredients for shopping, uses LLM-assisted deduplication where possible, lets users split or regenerate merged rows, and exposes a public view that behaves consistently for anonymous visitors.

## Test Scenarios

### 1. Combined Ingredient Rows

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. merges-trivial-variant-ingredients-300-g-tomato-300-g-tomatos-600-g-tomato

**File:** `tests/handoff-dedup.spec.ts`

**Steps:**
  1. With the OpenAI dedup mock enabled, log in and create two draft recipes: `Pasta al pomodoro` with `300 g tomato` and `Tomato soup` with `300 g tomatos`.
  2. Finalise the draft.
    - expect: The combined list contains exactly one row `600 g tomato`.
    - expect: That row is marked as merged.
    - expect: The merged row shows both source recipes, `Pasta al pomodoro` and `Tomato soup`.
    - expect: JSON-LD contains exactly one tomato ingredient, `600 g tomato`.

#### 1.2. split-a-merged-group-json-ld-expands-back-survives-reload-can-un-split

**File:** `tests/handoff-dedup.spec.ts`

**Steps:**
  1. With the OpenAI dedup mock enabled, log in, create the two tomato recipes, and finalise.
  2. Click `Split tomato`.
    - expect: `Undo split for tomato` is visible.
    - expect: JSON-LD tomato ingredients expand to `300 g tomato` and `300 g tomatos`.
  3. Reload the handoff page.
    - expect: `Undo split for tomato` remains visible.
    - expect: JSON-LD still contains `300 g tomato` and `300 g tomatos`.
  4. Click `Undo split for tomato`.
    - expect: `600 g tomato` is visible again.
    - expect: JSON-LD tomato ingredients collapse back to `600 g tomato`.

#### 1.3. incompatible-units-stay-as-separate-rows-200-g-flour-2-cups-flour

**File:** `tests/handoff-dedup.spec.ts`

**Steps:**
  1. With the OpenAI dedup mock enabled, log in and create draft recipes `Bread` with `200 g flour` and `Pancakes` with `2 cups flour`.
  2. Finalise the draft.
    - expect: The combined rows include one `200 g flour` row.
    - expect: The combined rows include one `2 cups flour` row.
    - expect: JSON-LD ingredients contain both `200 g flour` and `2 cups flour`.

### 2. Public and Failure Behaviour

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. public-anonymous-visitor-sees-combined-list-and-can-split

**File:** `tests/handoff-dedup.spec.ts`

**Steps:**
  1. With the OpenAI dedup mock enabled, log in, create the two tomato recipes, finalise, and open `/h/<flat id>` in a fresh anonymous context.
    - expect: `600 g tomato` is visible to the anonymous visitor.
  2. As the anonymous visitor, click `Split tomato`.
    - expect: `Undo split for tomato` is visible.

#### 2.2. llm-failure-during-finalise-redirect-still-happens-list-renders-as-singletons

**File:** `tests/handoff-dedup.spec.ts`

**Steps:**
  1. Force the OpenAI mock to return an error, then log in and create the two tomato draft recipes.
  2. Finalise the draft.
    - expect: Finalise still redirects to `/h/<flat id>` without hanging.
    - expect: The combined list shows `300 g tomato`.
    - expect: The combined list shows `300 g tomatos`.

#### 2.3. stale-snapshot-editing-a-recipe-after-finalise-shows-regenerate-clicking-it-re-merges

**File:** `tests/handoff-dedup.spec.ts`

**Steps:**
  1. With the OpenAI dedup mock enabled, log in, create the two tomato recipes, and finalise.
    - expect: `600 g tomato` is visible after finalise.
  2. Return home, open `Pasta al pomodoro`, edit its first ingredient amount to `500`, and save.
    - expect: Saving returns to a recipe detail URL.
  3. Reopen `/h/<flat id>`.
    - expect: A `Regenerate` button is visible.
    - expect: The stale combined list shows `500 g tomato` and `300 g tomatos` as separate rows.
  4. Click `Regenerate`.
    - expect: The combined list shows `800 g tomato`.
    - expect: The `Regenerate` button disappears.
