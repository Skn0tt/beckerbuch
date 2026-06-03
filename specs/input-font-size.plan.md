# Input Font Size Test Plan

## Application Overview

Form controls throughout authentication, recipe editing, settings, and invite redemption must render at 16px or larger so mobile Safari does not auto-zoom when users focus inputs.

## Test Scenarios

### 1. Mobile-safe Form Control Typography

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. visible-form-controls-use-at-least-16px-text-to-avoid-safari-auto-zoom

**File:** `tests/input-font-size.spec.ts`

**Steps:**
  1. Visit `/login` while logged out.
    - expect: At least one visible form control exists.
    - expect: Every visible input, textarea, or select has computed font size of at least 16px.
  2. Log in as the flat user and inspect the logged-in home screen.
    - expect: Every visible form control has computed font size of at least 16px.
  3. Open `/recipes/new`.
    - expect: Every visible form control has computed font size of at least 16px.
  4. Open `/flat/settings`, generate an invite link, and inspect the settings form controls.
    - expect: The Invite link field is visible.
    - expect: Every visible form control has computed font size of at least 16px.
  5. Clear cookies and open the generated invite URL.
    - expect: Every visible invite form control has computed font size of at least 16px.
