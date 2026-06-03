# Invite Test Plan

## Application Overview

Invite redemption is how a flat gains additional members, so the flow must create accounts, reject invalid or consumed links, preserve invitations after validation errors, and prevent already-joined users from joining again.

## Test Scenarios

### 1. Invite Redemption

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. happy-path-redeem-invite-land-on-home-as-new-member

**File:** `tests/invite.spec.ts`

**Steps:**
  1. As the existing flat user, generate an invite link, then clear cookies and open it.
    - expect: A `Join <flat name>` heading is visible.
  2. Fill the invite form with a new email, display name `Redeemer Cook`, and a valid password, then submit.
    - expect: The browser lands on `/`.
    - expect: The current-user display shows `Redeemer Cook`.

#### 1.2. invalid-token-404

**File:** `tests/invite.spec.ts`

**Steps:**
  1. Visit `/invite/this-token-does-not-exist` without using the flat fixture.
    - expect: The page response status is 404.

#### 1.3. already-used-invite-404

**File:** `tests/invite.spec.ts`

**Steps:**
  1. Generate an invite, open it logged out, and redeem it as `First Redeemer`.
    - expect: The browser lands on `/` after redemption.
  2. Clear cookies and open the same invite URL again.
    - expect: The page response status is 404.

#### 1.4. logged-in-user-is-told-theyre-already-in-a-flat

**File:** `tests/invite.spec.ts`

**Steps:**
  1. Generate an invite while staying logged in as the existing flat user, then open the invite URL.
    - expect: A heading says the user is already in a flat.
    - expect: The flat name is visible.

#### 1.5. weak-password-is-rejected-and-invite-stays-usable

**File:** `tests/invite.spec.ts`

**Steps:**
  1. Generate an invite, open it logged out, and submit the form with password `short`.
    - expect: A validation message says the password must be at least 12 characters.
    - expect: The browser remains on the invite URL.
  2. Reload the invite URL.
    - expect: The `Join <flat name>` form is still visible.

#### 1.6. email-already-taken-form-error-invite-not-consumed

**File:** `tests/invite.spec.ts`

**Steps:**
  1. Generate an invite, open it logged out, and submit the form using the existing flat user's email.
    - expect: A form error says the account already exists.
    - expect: The browser remains on the invite URL.
  2. Open the invite URL again.
    - expect: The response status is 200, showing the invite was not consumed.
