# Kptncook Import MCP Test Plan

## Application Overview

The MCP `fetch_recipe` tool exposes the same kptncook import normalization to external clients after OAuth authorization, returning structured recipe data or an error for invalid inputs.

## Test Scenarios

### 1. MCP fetch_recipe

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. returns-normalized-payload-for-a-share-url

**File:** `tests/kptncook-import-mcp.spec.ts`

**Steps:**
  1. With kptncook mocks enabled, log in, approve the OAuth consent screen, and connect an MCP client.
    - expect: OAuth succeeds and yields an access token.
  2. Call `fetch_recipe` with the mocked kptncook share URL.
    - expect: The tool result is not an error.
    - expect: The recipe name is `Zimtschnecken`.
    - expect: Base quantity is `2`.
    - expect: Source URL is the canonical mocked kptncook share URL.
    - expect: Ingredients equal `250 g Mehl`, `150 ml Milch`, and `2 Eier`.
    - expect: Steps include `Teig anrühren` and `180 °C`.
    - expect: A JPEG photo is returned with non-empty base64 data.

#### 1.2. works-with-a-bare-uid

**File:** `tests/kptncook-import-mcp.spec.ts`

**Steps:**
  1. With kptncook mocks enabled, log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the mocked bare uid and `includePhoto: false`.
    - expect: The tool result is not an error.
    - expect: The recipe name is `Zimtschnecken`.
    - expect: No photo is returned.

#### 1.3. returns-an-error-result-for-an-unparseable-input

**File:** `tests/kptncook-import-mcp.spec.ts`

**Steps:**
  1. With kptncook mocks enabled, log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with `not-a-real-id`.
    - expect: The tool result is an error.
