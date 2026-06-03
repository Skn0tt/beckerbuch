# Generic Recipe Import MCP Live Test Plan

## Application Overview

The live generic importer lets MCP clients fetch arbitrary public schema.org recipe pages, while rejecting pages without recipe data and refusing private/local addresses for SSRF safety.

## Test Scenarios

### 1. Live schema.org Imports

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. fetch-recipe-imports-bon-appetit-chocolate-chip-cookies

**File:** `tests/recipe-import-live.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the Bon Appétit chocolate chip cookies URL.
    - expect: The tool result is not an error.
    - expect: The name matches `cookie`.
    - expect: Base quantity is between 1 and 1000.
    - expect: Source URL is present and its host matches `bonappetit.com`.
    - expect: At least 5 ingredients are returned.
    - expect: Every ingredient has a non-empty item.
    - expect: At least one ingredient has a parsed amount.
    - expect: Steps are non-empty.
    - expect: A photo is returned with an image content type and non-empty base64.

#### 1.2. fetch-recipe-imports-love-and-lemons-banana-bread

**File:** `tests/recipe-import-live.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the Love and Lemons banana bread URL.
    - expect: The tool result is not an error.
    - expect: The name matches `banana bread`.
    - expect: Base quantity is between 1 and 1000.
    - expect: Source URL is present and its host matches `loveandlemons.com`.
    - expect: At least 6 ingredients are returned.
    - expect: Every ingredient has a non-empty item.
    - expect: At least one ingredient has a parsed amount.
    - expect: Steps are non-empty.
    - expect: A photo is returned with an image content type and non-empty base64.

#### 1.3. fetch-recipe-imports-sallys-baking-addiction-banana-bread

**File:** `tests/recipe-import-live.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the Sally's Baking Addiction banana bread URL.
    - expect: The tool result is not an error.
    - expect: The name matches `banana bread`.
    - expect: Base quantity is between 1 and 1000.
    - expect: Source URL is present and its host matches `sallysbakingaddiction.com`.
    - expect: At least 6 ingredients are returned.
    - expect: Every ingredient has a non-empty item.
    - expect: At least one ingredient has a parsed amount.
    - expect: Steps are non-empty.
    - expect: A photo is returned with an image content type and non-empty base64.

### 2. Import Error Handling

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. fetch-recipe-errors-on-a-page-with-no-recipe-data

**File:** `tests/recipe-import-live.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with `https://example.com/`.
    - expect: The tool result is an error.

#### 2.2. fetch-recipe-refuses-to-fetch-a-local-address-ssrf-guard

**File:** `tests/recipe-import-live.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with `http://localhost/admin`.
    - expect: The tool result is an error.
