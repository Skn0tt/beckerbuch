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
    - expect: Base quantity is `1`.
    - expect: Source URL is the canonical mocked kptncook share URL.
    - expect: Ingredients equal `250 g Mehl`, `150 ml Milch`, and `2 Eier`.
    - expect: Steps are the three mocked instructions with `<timer>` expanded to `15 Min.`, `30–40 Min.`, and `bis zu 25 Min.`.
    - expect: Steps do not contain a `<timer>` placeholder.
    - expect: A JPEG photo is returned with non-empty base64 data.
    - expect: The note tells the client to pass that photo object as the `photo` argument.

#### 1.2. works-with-a-bare-uid

**File:** `tests/kptncook-import-mcp.spec.ts`

**Steps:**
  1. With kptncook mocks enabled, log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the mocked bare uid and `includePhoto: false`.
    - expect: The tool result is not an error.
    - expect: The recipe name is `Zimtschnecken`.
    - expect: No photo is returned.
    - expect: The note says a photo is still required.

#### 1.3. add-recipe-stores-the-cover-fetch-recipe-already-downloaded

**File:** `tests/kptncook-import-mcp.spec.ts`

**Steps:**
  1. With kptncook mocks enabled, log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with the mocked kptncook share URL.
    - expect: The tool result is not an error.
    - expect: A photo is returned.
    - expect: The note does not say the photo cannot be carried through, and it tells the caller to pass the photo argument.
  3. Call `kochbuch_add_recipe` with the fetched fields, including that photo object.
    - expect: The tool result is not an error.
  4. Call `kochbuch_get_recipe` and fetch the photo URL.
    - expect: The photo URL contains `/r/<id>/photo`.
    - expect: The response is `image/jpeg` and the bytes match the fetched photo.
  5. Open the home page.
    - expect: An image named `Zimtschnecken` is visible.
    - expect: Its src points at `/recipes/<id>/photo`.

#### 1.4. returns-an-error-result-for-an-unparseable-input

**File:** `tests/kptncook-import-mcp.spec.ts`

**Steps:**
  1. With kptncook mocks enabled, log in, approve OAuth, and connect an MCP client.
  2. Call `fetch_recipe` with `not-a-real-id`.
    - expect: The tool result is an error.
