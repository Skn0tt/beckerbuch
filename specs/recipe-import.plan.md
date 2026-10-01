# Generic Recipe Import MCP Test Plan

## Application Overview

The generic importer lets MCP clients fetch public schema.org recipe pages, while rejecting pages without recipe data and refusing private/local addresses for SSRF safety. These tests serve canned HTML and cover images through the HTTP mock (`tests/schema-org-fixtures/`, `cannedRecipePagesHandler`). They do not fetch the real hosts. Sally's Baking Addiction is not in the set — that URL returns HTTP 403.

## Test Scenarios

### 1. Schema.org Imports

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. fetch-recipe-imports-bon-appetit-chocolate-chip-cookies

**File:** `tests/recipe-import.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the Bon Appétit chocolate chip cookies URL. The response bytes come from `tests/schema-org-fixtures/bon-appetit-chocolate-chip-cookies.html` and `cover.jpg`.
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

**File:** `tests/recipe-import.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the Love and Lemons banana bread URL. The response bytes come from `tests/schema-org-fixtures/love-and-lemons-banana-bread.html` and `cover.jpg`.
    - expect: The tool result is not an error.
    - expect: The name matches `banana bread`.
    - expect: Base quantity is between 1 and 1000.
    - expect: Source URL is present and its host matches `loveandlemons.com`.
    - expect: At least 6 ingredients are returned.
    - expect: Every ingredient has a non-empty item.
    - expect: At least one ingredient has a parsed amount.
    - expect: Steps are non-empty.
    - expect: A photo is returned with an image content type and non-empty base64.

### 2. Import Error Handling

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. fetch-recipe-errors-on-a-page-with-no-recipe-data

**File:** `tests/recipe-import.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with `https://example.com/`. The response bytes come from `tests/schema-org-fixtures/example-no-recipe.html` (a WebSite JSON-LD node, not a Recipe).
    - expect: The tool result is an error.

#### 2.2. fetch-recipe-refuses-to-fetch-a-local-address-ssrf-guard

**File:** `tests/recipe-import.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with `http://localhost/admin`.
    - expect: The tool result is an error.
    - expect: The refusal happens before any fetch (localhost is rejected by the SSRF guard).
