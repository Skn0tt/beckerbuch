# Notes Test Plan

## Application Overview

Kitchen notes let flat members attach private planning details to draft and stock items, preserve them through finalise, edit or clear them, and keep them out of the public handoff page while maintaining responsive card layouts.

## Test Scenarios

### 1. Draft Notes

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. note-add-to-draft-item-persists-across-reload

**File:** `tests/notes.spec.ts`

**Steps:**
  1. With the OpenAI dedup mock enabled, log in, create `Pasta al limone`, add it to the draft, and open `/kitchen`.
    - expect: The `Add note for Pasta al limone` button is visible.
    - expect: No note text is visible yet.
  2. Click Add note, type `cook this on Friday`, and press Enter.
    - expect: The note text shows `cook this on Friday`.
  3. Reload the page.
    - expect: The note text still shows `cook this on Friday`.

#### 1.2. note-edit-existing

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Log in, create and draft `Pasta al limone`, add note `first version`, and save it.
    - expect: The note text shows `first version`.
  2. Click `Edit note for Pasta al limone`.
    - expect: The note input is prefilled with `first version`.
  3. Replace it with `second version` and press Enter.
    - expect: The note text shows `second version`.

#### 1.3. note-clearing-an-existing-note-returns-the-note-button

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Log in, create and draft `Pasta al limone`, add note `to be cleared`, and save it.
    - expect: The note text shows `to be cleared`.
  2. Edit the note, clear the input, and press Enter.
    - expect: No note text remains.
    - expect: The `Add note for Pasta al limone` button is visible.
  3. Reload the page.
    - expect: No note text remains.
    - expect: The Add note button is still visible.

### 2. Stock Notes

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. note-persists-through-finalise-into-the-in-stock-lane

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Log in, create and draft `Pasta al limone`, add note `survives finalise`, and save it.
    - expect: The note text shows `survives finalise`.
  2. Finalise the draft and open `/kitchen?lane=stock`.
    - expect: Finalising redirects to `/h/<flat id>`.
    - expect: The stock item note still shows `survives finalise`.

#### 2.2. note-editable-on-in-stock-items-too

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Log in, create and draft `Pasta al limone`, finalise it, and open `/kitchen?lane=stock`.
    - expect: Finalising redirects to `/h/<flat id>`.
  2. Click Add note on the stock item, type `added after finalise`, and press Enter.
    - expect: The stock item note text shows `added after finalise`.

#### 2.3. note-does-not-appear-on-the-public-h-flatid-handoff-page

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Log in, create and draft `Pasta al limone`, add note `internal note - should not leak`, and save it.
    - expect: The private kitchen note is visible to the logged-in user.
  2. Finalise the draft and open `/h/<flat id>` in a fresh anonymous context.
    - expect: The public page shows a `Pasta al limone (serves 4)` recipe link.
    - expect: No text matching `internal note` is visible.

### 3. Responsive Note Layout

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 3.1. note-mobile-keeps-note-with-controls-when-empty-moves-note-below-once-filled

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Set a 390×844 mobile viewport, log in, create and draft `Pasta al limone`, and open `/kitchen`.
    - expect: The Add note button is visible.
    - expect: The decrease-portions button is visible.
    - expect: The Add note button sits in the same controls row as the cook picker.
  2. Add note `cook first`, wait for it to save, reload, and remain on `/kitchen`.
    - expect: The note text shows `cook first`.
    - expect: The filled note text is no longer inside the controls row.

#### 3.2. note-mobile-stock-card-keeps-title-top-quantity-top-right-and-avatar-note-cooked-on-one-row

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Set a 390×844 mobile viewport, log in, create and draft `Pasta al limone`, finalise it, and open `/kitchen?lane=stock`.
    - expect: The quantity `4` is visible.
    - expect: The cook picker is visible.
    - expect: The Add note button is visible.
    - expect: The mark-cooked button text is `✓`.
    - expect: The title is above the controls row.
    - expect: The quantity is above the controls row and to the right of the title.
    - expect: The cook picker, Add note button, and mark-cooked button share one row in left-to-right order.

#### 3.3. note-desktop-stock-card-keeps-title-top-quantity-top-right-and-avatar-note-cooked-on-one-row

**File:** `tests/notes.spec.ts`

**Steps:**
  1. Set a 1280×800 desktop viewport, log in, create and draft `Pasta al limone`, finalise it, and open `/kitchen?lane=stock`.
    - expect: The quantity `4` is visible.
    - expect: The cook picker is visible.
    - expect: The Add note button is visible.
    - expect: The mark-cooked button text is `✓`.
    - expect: The title is above the controls row.
    - expect: The quantity is above the controls row and to the right of the title.
    - expect: The cook picker, Add note button, and mark-cooked button share one row in left-to-right order.
