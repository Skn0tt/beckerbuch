# Login Test Plan

## Application Overview

Authentication gates the cookbook so flat members can sign in, recover intended destinations after being redirected, avoid unsafe redirects, and fully sign out.

## Test Scenarios

### 1. Sign-in and Session Boundaries

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. happy-path-log-in-lands-on-home

**File:** `tests/login.spec.ts`

**Steps:**
  1. Visit the login page, enter the flat user's email and password, and submit the form.
    - expect: The browser lands on `/`.
    - expect: The current-user display shows the flat user's display name.

#### 1.2. wrong-password-shows-error-and-stays-on-login

**File:** `tests/login.spec.ts`

**Steps:**
  1. Visit `/login`, enter the flat user's email with an incorrect password, and click Sign in.
    - expect: The browser remains on a login URL.
    - expect: An alert contains a generic invalid-login message.

#### 1.3. unknown-email-shows-the-same-generic-error

**File:** `tests/login.spec.ts`

**Steps:**
  1. Visit `/login`, enter an unknown email and any password, and click Sign in.
    - expect: The browser remains on a login URL.
    - expect: An alert contains a generic invalid-login message.

#### 1.4. redirect-after-login-preserves-the-original-target

**File:** `tests/login.spec.ts`

**Steps:**
  1. As an anonymous visitor, open `/?welcome=1`.
    - expect: The browser is redirected to `/login?redirect=...`.
  2. Enter the flat user's valid credentials and submit.
    - expect: The browser returns to `/?welcome=1`.

#### 1.5. open-redirect-via-redirect-is-rejected

**File:** `tests/login.spec.ts`

**Steps:**
  1. Visit `/login?redirect=https://evil.example/owned`, enter valid credentials, and submit.
    - expect: The browser lands on `/`, not the external URL.

#### 1.6. logout-returns-to-login-and-home-is-gated-again

**File:** `tests/login.spec.ts`

**Steps:**
  1. Log in as the flat user, open Settings, and click Sign out.
    - expect: The browser lands on a login URL.
  2. Try to open `/` again while signed out.
    - expect: The browser is redirected to `/login?redirect=...`.
