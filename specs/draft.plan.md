# Draft Kitchen Test Plan

## Application Overview

The draft kitchen lets members plan recipes, adjust serving quantities, assign cooks, finalise stock, and keep each flat's planning state isolated across desktop and mobile layouts.

## Test Scenarios

### 1. Draft Membership and Empty States

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. add-a-recipe-to-draft-button-flips-to-in-draft-kitchen-shows-one-entry-remove-can-add-again

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone` with `400 g spaghetti`, and click `+ Add to draft` on the recipe detail page.
    - expect: The button changes to `✓ In draft`.
    - expect: No `+ Add to draft` button remains on the detail page.
  2. Open `/kitchen`.
    - expect: The URL is `/kitchen`.
    - expect: `Draft 1` is visible.
    - expect: There is exactly one `Pasta al limone` link.
  3. Decrease portions four times and confirm removal from draft.
    - expect: There are no `Pasta al limone` links in the draft.
  4. Return to the recipe detail page.
    - expect: The `+ Add to draft` button is visible again.

#### 1.2. kitchen-empty-state-links-back-to-collection

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Log in and open `/kitchen` with no draft items.
    - expect: The URL is `/kitchen`.
    - expect: A `Draft is empty` empty-state message is visible.

#### 1.3. mobile-kitchen-card-puts-recipe-name-above-controls

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Set a 390×844 mobile viewport, log in, create `Pasta al limone`, add it to the draft, and open `/kitchen`.
    - expect: The recipe link is visible.
    - expect: The decrease-portions button is visible.
    - expect: The decrease control is visually below the recipe name.

#### 1.4. draft-is-scoped-to-the-flat-other-flats-draft-is-invisible

**File:** `tests/draft.spec.ts`

**Steps:**
  1. In flat A, log in, create `Pasta al limone`, and add it to the draft.
    - expect: The recipe button changes to `✓ In draft`.
  2. Clear cookies, provision and join a second flat as `Other Cook`, then open `/kitchen`.
    - expect: The second flat shows `Draft is empty`.

### 2. Quantity Scaling

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. change-target-portions-ingredients-re-scale

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone` with base 4 portions and `400 g spaghetti`, then add it to the draft.
    - expect: `400 g spaghetti` is visible initially.
  2. Increase portions twice.
    - expect: The scaled ingredient changes to `600 g spaghetti`.
  3. Decrease portions five times to one serving.
    - expect: The scaled ingredient changes to `100 g spaghetti`.
  4. Decrease once more and cancel the remove-confirm modal.
    - expect: `100 g spaghetti` remains visible.

#### 2.2. recipe-view-scales-ingredients-immediately-while-quantity-update-is-in-flight

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, add it to the draft, and delay quantity-update responses.
    - expect: `400 g spaghetti` is visible before changing quantity.
  2. Click the increase-portions button once.
    - expect: `500 g spaghetti` appears immediately before the delayed network update completes.

### 3. Designated Cooks and Stock

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 3.1. designated-cook-picker-assign-self-then-unassign

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, add it to the draft, and open `/kitchen`.
  2. Open the cook picker for the recipe.
    - expect: `Set cook to unassigned` is pressed by default.
  3. Choose the flat user as cook, wait for the save, reload, and reopen the picker.
    - expect: `Set cook to <display name>` is pressed.
  4. Choose unassigned, wait for the save, reload, and reopen the picker.
    - expect: `Set cook to unassigned` is pressed.

#### 3.2. designated-cook-can-be-edited-in-stock-lane

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, add it to the draft, finalise it, and open `/kitchen?lane=stock`.
    - expect: Finalising redirects to a public handoff URL.
  2. Open the cook picker, choose the flat user, wait for the save, reload, and reopen the picker.
    - expect: `Set cook to <display name>` is pressed in the stock lane.

#### 3.3. finalise-draft-in-stock-lane-mark-cooked-empty

**File:** `tests/draft.spec.ts`

**Steps:**
  1. Log in, create `Pasta al limone`, add it to the draft, and open `/kitchen`.
    - expect: `Draft 1` is visible.
    - expect: `In stock 0` is visible.
  2. Finalise the draft.
    - expect: The browser redirects to `/h/<flat id>`.
  3. Return to `/kitchen`.
    - expect: `Draft 0` is visible.
    - expect: `In stock 1` is visible.
  4. Click the In stock lane.
    - expect: The URL ends with `?lane=stock`.
    - expect: The `Pasta al limone` stock link is visible.
  5. Mark `Pasta al limone` as cooked and confirm.
    - expect: `In stock 0` is visible.
    - expect: `Nothing in stock yet` is visible.
