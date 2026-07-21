# Cold-start skeleton Test Plan

## Overview

Cold starts and slow Neon round-trips should paint app chrome immediately with
skeleton placeholders (and a thin nav progress bar on client navigations)
instead of a blank white page while loaders finish.

## Test Cases

### 1. Resting UI still works with streamed loaders

#### 1.1. home-renders-empty-state-when-logged-in

**File:** `tests/smoke.spec.ts`

**Steps:**
  1. Log in and land on home.
    - expect: Draft heading is visible (sidebar resolved).
    - expect: "No recipes yet" empty state is visible (list resolved).

#### 1.2. nav-progress-appears-while-a-slow-navigation-is-in-flight

**File:** `tests/loading-skeleton.spec.ts`

**Steps:**
  1. Log in on home.
  2. Intercept `/flat/settings.data` and hold it open.
  3. Click the Settings avatar link.
    - expect: `[data-testid=nav-progress]` becomes visible while the navigation is pending.
  4. Release the intercepted request.
    - expect: Flat settings UI is visible.
    - expect: nav-progress is gone.
