# MCP Server Test Plan

## Application Overview

The MCP server exposes OAuth-protected cookbook tools for external clients, including recipe creation, search, retrieval, editing, image handling, discovery metadata, dynamic client registration, refresh-token rotation, and consent decisions.

## Test Scenarios

### 1. MCP Recipe Creation

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 1.1. add-recipe-happy-path-no-photo

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve the OAuth consent screen, and connect an MCP client.
    - expect: The consent page shows `Authorize access` and OAuth succeeds.
  2. Call `kochbuch_add_recipe` with `MCP Pancakes`, base quantity 4, ingredients `200 g flour`, `300 ml milk`, `salt`, and steps `Mix and fry.`.
    - expect: The tool result is not an error.
    - expect: The result contains only an id and URL.
    - expect: The URL contains `/recipes/<id>`.
  3. Return to the app home page.
    - expect: `MCP Pancakes` is visible.

#### 1.2. add-recipe-with-photourl-stores-the-image

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Start a tiny image server, then log in, approve OAuth, and connect an MCP client.
  2. Call `kochbuch_add_recipe` with `MCP Photo Recipe` and a valid PNG photo URL.
    - expect: The tool result is not an error.
  3. Open the app home page and click `MCP Photo Recipe`.
    - expect: An image named `MCP Photo Recipe` is visible.

#### 1.3. add-recipe-rejects-non-image-photourl

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Start a tiny text server, then log in, approve OAuth, and connect an MCP client.
  2. Call `kochbuch_add_recipe` with `Should Not Exist` and a text-file photo URL.
    - expect: The tool result is an error.
  3. Open the home page.
    - expect: `Should Not Exist` is not visible.

#### 1.4. add-recipe-rejects-empty-ingredients

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve OAuth, and connect an MCP client.
  2. Call `kochbuch_add_recipe` with name `Empty`, base quantity 1, and an empty ingredient list.
    - expect: The tool result is an error.

### 2. MCP Search and Retrieval

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 2.1. search-recipes-returns-matches-empty-results-and-respects-limit

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve OAuth, connect an MCP client, and add `Pasta al limone`, `Chicken curry`, and `Sourdough loaf` through MCP.
  2. Search for `chick` with limit 1.
    - expect: The tool result is not an error.
    - expect: Exactly one result is returned.
    - expect: The result name is `Chicken curry`.
    - expect: The result includes app and public recipe URLs.
  3. Search for `kingarthur`.
    - expect: The result names equal `Sourdough loaf`.
  4. Search for `nothingmatchesthis`.
    - expect: The result list is empty.
  5. Search with only `limit: 2`.
    - expect: Exactly two results are returned.
  6. Repeat an unfiltered search twice.
    - expect: The two result id orders are identical.

#### 2.2. get-recipe-returns-flat-owned-recipes-and-hides-other-flats

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve OAuth, connect an MCP client, and add `MCP Soup` with base quantity 4, ingredients `1 l water` and `salt`, steps `Boil.`, and source URL `https://example.com/soup`.
  2. Call `kochbuch_get_recipe` for the new recipe.
    - expect: The tool result is not an error.
    - expect: The returned id, name, base quantity, steps, source host, null photo URL, and ingredients match the created recipe.
  3. Create and authorize a second isolated flat, then call `kochbuch_get_recipe` for the first flat's recipe.
    - expect: The tool result is an error.
    - expect: The tool text is `Recipe not found.`.

#### 2.3. search-recipes-works-with-no-arguments-at-all

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve OAuth, connect an MCP client, and add `Only Recipe`.
  2. Call `kochbuch_search_recipes` with an empty arguments object.
    - expect: The tool result is not an error.
    - expect: The returned query is an empty string.
    - expect: Results contain `Only Recipe`.
  3. Call `kochbuch_search_recipes` with no arguments field at all.
    - expect: The tool result is not an error.
    - expect: Results contain `Only Recipe`.

### 3. MCP Editing

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 3.1. edit-recipe-patches-recipe-fields-and-replaces-ingredients

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve OAuth, connect an MCP client, and add `Old Name` with `1 cup rice` and `Old steps`.
  2. Call `kochbuch_edit_recipe` to rename it to `New Name`.
    - expect: The tool result is not an error.
    - expect: The result id and URL reference the edited recipe.
  3. Call `kochbuch_edit_recipe` to replace ingredients with `200 g pasta` and `pepper`.
    - expect: The tool result is not an error.
    - expect: The result id and URL reference the edited recipe.
  4. Open the recipe detail page in the app.
    - expect: The heading `New Name` is visible.
    - expect: `200 g pasta` and `pepper` are visible.
    - expect: `1 cup rice` is absent.

#### 3.2. edit-recipe-can-add-and-remove-a-photo

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Start a tiny image server, then log in, approve OAuth, connect an MCP client, and add `Photo Patch` without a photo.
  2. Call `kochbuch_edit_recipe` with a valid photo URL.
    - expect: The tool result is not an error and references the recipe id and URL.
  3. Call `kochbuch_get_recipe`.
    - expect: The tool result is not an error.
    - expect: The photo URL contains `/r/<recipe id>/photo`.
  4. Open the recipe page.
    - expect: An image named `Photo Patch` is visible.
  5. Call `kochbuch_edit_recipe` with `removePhoto: true`, then call `kochbuch_get_recipe` again.
    - expect: The edit result is not an error and references the recipe id and URL.
    - expect: The fetched recipe photo URL is null.
  6. Reopen the recipe page.
    - expect: No image named `Photo Patch` remains.

#### 3.3. edit-recipe-rejects-cross-flat-access-and-conflicting-photo-options

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve OAuth, connect an MCP client, and add `Private Recipe`.
  2. Call `kochbuch_edit_recipe` with both `photoUrl` and `removePhoto`.
    - expect: The tool result is an error.
    - expect: The tool text is `photoUrl and removePhoto cannot be used together.`.
  3. Create and authorize a second isolated flat, then try editing the first flat's recipe.
    - expect: The tool result is an error.
    - expect: The tool text is `Recipe not found.`.

#### 3.4. edit-recipe-accepts-ingredients-and-basequantity-together

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, approve OAuth, connect an MCP client, and add `Combo Edit` with base quantity 2 and `1 cup rice`.
  2. Call `kochbuch_edit_recipe` with base quantity 6 and ingredients `1 cup rice` and `2 tbsp soy sauce` in the same request.
    - expect: The tool result is not an error and references the recipe id and URL.
  3. Call `kochbuch_get_recipe`.
    - expect: The tool result is not an error.
    - expect: Base quantity is 6.
    - expect: Ingredients equal `1 cup rice` and `2 tbsp soy sauce`.

### 4. MCP and OAuth Protocol Endpoints

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant + first user, leaves browser logged out)

#### 4.1. mcp-returns-401-www-authenticate-without-a-bearer

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Submit an MCP initialize request to `/mcp` without a bearer token.
    - expect: The response status is 401.
    - expect: The `WWW-Authenticate` header contains `Bearer`.
    - expect: The header advertises `/.well-known/oauth-protected-resource/mcp`.

#### 4.2. oauth-protected-resource-metadata-is-served-at-both-the-bare-and-path-suffixed-urls

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Fetch `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` without using the flat fixture.
    - expect: Each response status is 200.
    - expect: Each response content type contains `application/json`.
    - expect: Each metadata body has resource `<baseURL>/mcp`.
    - expect: Each authorization server list equals `[<baseURL>]`.

#### 4.3. authorization-server-metadata-is-served-at-oauth-authorization-server-and-openid-configuration

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Fetch `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` without using the flat fixture.
    - expect: Each response status is 200.
    - expect: Each body advertises issuer `<baseURL>`.
    - expect: Each body advertises registration endpoint `/oauth/register`, authorization endpoint `/oauth/authorize`, and token endpoint `/oauth/token`.

#### 4.4. dynamic-client-registration-is-reachable-at-both-oauth-register-and-register

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. POST dynamic-client-registration data to `/oauth/register` and `/register` without using the flat fixture.
    - expect: Each response status is 201.
    - expect: Each client id starts with `mcp_`.
    - expect: Each response includes a numeric positive `client_id_issued_at`.
    - expect: Each response scope is `recipes:write`.

#### 4.5. registration-echoes-a-requested-scope

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. POST dynamic-client-registration data with scope `recipes:write` to `/oauth/register` without using the flat fixture.
    - expect: The response status is 201.
    - expect: The response scope is `recipes:write`.

#### 4.6. refresh-token-rotates-and-revokes-the-old-one

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in and complete OAuth approval.
  2. Exchange the refresh token once.
    - expect: The refresh response is successful.
  3. Try to exchange the original refresh token again.
    - expect: The response status is 400.
  4. Connect an MCP client with the new access token and add recipe `After Refresh`.
    - expect: The MCP call is not an error.

#### 4.7. deny-on-the-consent-screen-returns-access-denied

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, open the OAuth consent screen, and click Deny.
    - expect: OAuth returns an unsuccessful result.
    - expect: The error is `access_denied`.

#### 4.8. authorize-approve-returns-an-http-302-to-the-redirect-uri-not-a-single-fetch-202

**File:** `tests/mcp.spec.ts`

**Steps:**
  1. Log in, register an OAuth client, and fetch the consent page for an authorization request.
    - expect: The consent page response status is 200.
    - expect: The consent HTML contains a CSRF token.
  2. Submit approval directly to `/oauth/authorize` with redirects disabled.
    - expect: The response status is 302.
    - expect: The `Location` header points to the redirect URI.
    - expect: The redirect query contains the original state.
    - expect: The redirect query contains an authorization code.
