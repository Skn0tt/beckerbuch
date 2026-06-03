# Finalise Draft Test Plan

## Application Overview

Finalising turns a member's draft recipes into an in-stock handoff page with shareable public views and structured JSON-LD, while keeping empty drafts and older stock from leaking into the latest handoff.

## Test Scenarios

### 1. Finalising Drafts

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. empty-draft-finalise-button-is-not-visible

**File:** `tests/finalise.spec.ts`

**Steps:**
  1. Log in and open `/kitchen` with no draft items.
    - expect: `Draft 0` is visible.
    - expect: There is no `Finalise draft` button.

#### 1.2. finalise-confirm-modal-redirects-to-h-flatid-items-in-stock

**File:** `tests/finalise.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone` with `400 g spaghetti`, and add it to the draft.
    - expect: Saving lands on a recipe detail URL.
    - expect: The recipe button changes to `✓ In draft`.
  2. Open `/kitchen` and click `Finalise draft`.
    - expect: The confirmation modal asks `Finalise this draft?`.
    - expect: The modal lists `Pasta al limone (serves 4)`.
  3. Click `Confirm finalise draft`.
    - expect: The browser redirects to `/h/<flat id>`.
    - expect: A link for `Pasta al limone (serves 4)` is visible.

#### 1.3. finalise-while-existing-stock-handoff-includes-only-latest-draft-batch

**File:** `tests/finalise.spec.ts`

**Steps:**
  1. Log in, create and finalise `Pasta al limone`.
    - expect: The first finalise redirects to `/h/<flat id>`.
  2. Create `Risotto` with `300 g rice`, add it to the draft, and finalise again.
    - expect: The second handoff URL is `/h/<flat id>`.
    - expect: The handoff does not show `Pasta al limone (serves 4)`.
    - expect: The handoff shows `Risotto (serves 4)`.

### 2. Public Recipe and Handoff Pages

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. public-r-id-renders-recipe-json-ld-no-auth-required

**File:** `tests/finalise.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, capture its recipe id, then open `/r/<recipe id>` in a fresh anonymous context.
    - expect: The `Pasta al limone` heading is visible.
    - expect: `400 g spaghetti` is visible.
    - expect: `Serves 4` is visible.
    - expect: The JSON-LD script exists.
    - expect: JSON-LD has `@type` `Recipe`, name `Pasta al limone`, yield `4 servings`, and ingredient `400 g spaghetti`.

#### 2.2. public-r-id-q-8-scales-ingredients

**File:** `tests/finalise.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, then open `/r/<recipe id>?q=8` in a fresh anonymous context.
    - expect: `Serves 8` is visible.
    - expect: `800 g spaghetti` is visible.
    - expect: JSON-LD yield is `8 servings`.
    - expect: JSON-LD ingredients include `800 g spaghetti`.

#### 2.3. public-h-flatid-renders-stock-json-ld-no-auth-required

**File:** `tests/finalise.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, add it to the draft, and finalise.
    - expect: The browser redirects to `/h/<flat id>`.
  2. Open `/h/<flat id>` in a fresh anonymous context.
    - expect: A link for `Pasta al limone (serves 4)` is visible.
    - expect: JSON-LD has `@type` `Recipe`.
    - expect: JSON-LD ingredients include `400 g spaghetti`.

#### 2.4. public-h-flatid-404-for-invalid-flat-id

**File:** `tests/finalise.spec.ts`

**Steps:**
  1. Without using the flat fixture, open `/h/not-a-uuid` in a fresh anonymous context.
    - expect: The response status is 404.
