# Cold-start skeleton Test Plan

## Overview

Cold starts paint CDN-served skeleton shells (prerendered at build time into
`build/client/{index,kitchen,login}.html`). After hydrate, `_app` fetches
`/data/app` and revalidates child loaders — so a sleeping Netlify Function is
no longer on the critical path for first paint. A thin nav progress bar still
covers slow client navigations.

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

#### 1.3. prerendered-index-html-contains-workspace-skeletons

**File:** `tests/loading-skeleton.spec.ts`

**Steps:**
  1. Read `build/client/index.html` from the production build.
    - expect: File contains `Loading recipes`.
    - expect: File contains `Loading kitchen`.
