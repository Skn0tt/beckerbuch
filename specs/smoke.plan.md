# Smoke Test Plan

## Application Overview

The smoke checks prove the production-built app boots, protects the home route for anonymous users, and exposes the primary logged-in empty-state and navigation prefetch affordances.

## Test Scenarios

### 1. Basic App Health

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. home-renders-empty-state-when-logged-in

**File:** `tests/smoke.spec.ts`

**Steps:**
  1. Log in as the flat user and land on home.
    - expect: The Draft heading is visible.
    - expect: The `No recipes yet` empty state is visible.

#### 1.2. home-redirects-to-login-when-anonymous

**File:** `tests/smoke.spec.ts`

**Steps:**
  1. Without logging in, visit `/`.
    - expect: The browser is redirected to `/login?redirect=...`.

#### 1.3. hovering-new-recipe-prefetches-its-route-data

**File:** `tests/smoke.spec.ts`

**Steps:**
  1. Log in as the flat user and hover the `+ New recipe` link.
    - expect: The document head eventually contains a prefetch link for `/recipes/new`.
