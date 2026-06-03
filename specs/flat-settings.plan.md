# Flat Settings Test Plan

## Application Overview

Flat settings let members manage invites, view their membership, configure MCP connectors, upload avatars, edit display names, and sign out from the shared household.

## Test Scenarios

### 1. Members and Invites

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. settings-shows-flat-name-current-user-as-member-and-a-generate-button

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Log in as the flat user and click the Settings link.
    - expect: The browser URL is `/flat/settings`.
    - expect: The `Members` heading is visible.
    - expect: The member list row containing the flat user's email also shows the user's display name.
    - expect: The member list row shows the user's email.
    - expect: A Generate invite button is visible.

#### 1.2. generate-link-creates-an-invite-that-works

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Log in, open settings, and generate an invite link.
    - expect: The generated URL contains `/invite/`.
  2. Open the invite URL in a fresh browser context.
    - expect: The `Join <flat name>` heading is visible, not a 404.

#### 1.3. generate-new-link-rotates-the-previous-one

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Generate an invite link from settings.
  2. Click Generate again.
    - expect: The Invite link field eventually changes to a different URL.
  3. Open the first URL in a fresh browser context.
    - expect: The old invite now returns 404.

#### 1.4. anonymous-visit-redirects-to-login

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Without using the flat fixture or logging in, visit `/flat/settings`.
    - expect: The browser is redirected to `/login?redirect=...`.

### 2. Connector and Profile Settings

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. settings-shows-the-mcp-url-with-a-copy-button-and-a-link-to-claude-docs

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Log in and open `/flat/settings`.
    - expect: The `MCP URL` input is visible.
    - expect: Its value ends with `/mcp` and has pathname `/mcp`.
    - expect: A Copy button is visible near the MCP URL.
    - expect: The Claude link points to the documented custom-connector URL.
    - expect: The Claude link opens in a new tab (`target="_blank"`).

#### 2.2. clicking-avatar-opens-picker-and-uploads-profile-picture

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Log in, open settings, click `Change profile picture`, and select a tiny PNG file.
    - expect: An image with the user's display name as accessible name is visible.

#### 2.3. display-name-is-editable-inline-on-settings

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Log in, open settings, click the current display name, type `<current name> Updated`, and press Enter.
    - expect: The Display name input is focused after clicking the name.
    - expect: The current-user display updates to the new name.
    - expect: The member list row for the user's email shows the new name.

#### 2.4. display-name-saves-on-deselect-blur-in-settings

**File:** `tests/flat-settings.spec.ts`

**Steps:**
  1. Log in, open settings, click the current display name, type `<current name> Blur`, then click the Members heading to blur the input.
    - expect: The current-user display updates to the new name.
    - expect: The member list row for the user's email shows the new name.
