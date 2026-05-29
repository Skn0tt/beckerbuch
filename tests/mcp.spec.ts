import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, expect } from "./fixtures";
import { login } from "./login";

// Set per-test from the `baseURL` fixture. Lives at module scope so
// the many helpers below don't all need plumbing — see beforeEach.
let BASE_URL = "";

test.beforeEach(({ baseURL }) => {
  if (!baseURL) throw new Error("baseURL fixture not set");
  BASE_URL = baseURL;
});

// Smallest possible valid PNG: 1x1 transparent pixel.
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000156a4179f0000000049454e44ae426082",
  "hex",
);

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function startRedirectCatcher(): Promise<{
  url: string;
  waitForCode: () => Promise<URL>;
  close: () => Promise<void>;
}> {
  let resolveUrl!: (u: URL) => void;
  const captured = new Promise<URL>((r) => {
    resolveUrl = r;
  });
  const server = createServer((req, res) => {
    const full = new URL(req.url ?? "/", "http://placeholder");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    resolveUrl(full);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}/cb`;
  return {
    url,
    waitForCode: () => captured,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

type OAuthResult = {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  verifier: string;
};

async function registerClient(redirectUri: string): Promise<{ clientId: string }> {
  const res = await fetch(`${BASE_URL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Playwright test client",
      redirect_uris: [redirectUri],
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { client_id: string };
  return { clientId: body.client_id };
}

/**
 * Drive the browser through the full DCR + OAuth + token-exchange flow,
 * returning an access token. Assumes the page is already logged in.
 */
async function runOAuthFlow(
  page: import("@playwright/test").Page,
  opts: { decision: "approve" | "deny" } = { decision: "approve" },
): Promise<{ ok: true; tokens: OAuthResult } | { ok: false; error: string; state: string }> {
  const catcher = await startRedirectCatcher();
  try {
    const { clientId } = await registerClient(catcher.url);
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(16));

    const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", catcher.url);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "recipes:write");

    await page.goto(authorizeUrl.toString());
    await expect(page.getByRole("heading", { name: "Authorize access" })).toBeVisible();
    const buttonName = opts.decision === "approve" ? "Approve" : "Deny";
    await page.getByRole("button", { name: buttonName }).click();

    const cap = await catcher.waitForCode();
    expect(cap.searchParams.get("state")).toBe(state);

    const error = cap.searchParams.get("error");
    if (error) {
      return { ok: false, error, state: cap.searchParams.get("state") ?? "" };
    }

    const code = cap.searchParams.get("code");
    if (!code) throw new Error("no code in redirect");

    const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: catcher.url,
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error(`token failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    return {
      ok: true,
      tokens: {
        accessToken: tokenBody.access_token,
        refreshToken: tokenBody.refresh_token,
        clientId,
        verifier,
      },
    };
  } finally {
    await catcher.close();
  }
}

async function mcpClient(accessToken: string): Promise<Client> {
  const client = new Client(
    { name: "playwright-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
  await client.connect(transport);
  return client;
}

function textFromToolResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("tool result did not contain text");
  return text;
}

function jsonFromToolResult<TResult>(
  result: Awaited<ReturnType<Client["callTool"]>>,
): TResult {
  return JSON.parse(textFromToolResult(result)) as TResult;
}

function recipeRefFromToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): { id: string; url: string } {
  const body = jsonFromToolResult<Record<string, unknown>>(result);
  expect(Object.keys(body).sort()).toEqual(["id", "url"]);
  expect(body.id).toEqual(expect.any(String));
  expect(body.url).toEqual(expect.any(String));
  return body as { id: string; url: string };
}

async function addRecipeViaMcp(
  client: Client,
  args: {
    name: string;
    baseQuantity?: number;
    ingredients?: Array<{ amount?: string; unit?: string; item: string }>;
    steps?: string;
    sourceUrl?: string;
    photoUrl?: string;
  },
): Promise<string> {
  const callResult = await client.callTool({
    name: "kochbuch_add_recipe",
    arguments: {
      baseQuantity: 1,
      ingredients: [{ item: "water" }],
      ...args,
    },
  });
  expect(callResult.isError).toBeFalsy();
  const body = recipeRefFromToolResult(callResult);
  const match = body.url.match(/\/recipes\/([0-9a-f-]{36})/);
  if (!match) throw new Error("tool did not return a recipe url");
  return match[1];
}

async function createIsolatedFlatAccessToken(
  page: Page,
  request: APIRequestContext,
): Promise<string> {
  await page.context().clearCookies();
  const adminRes = await request.post("/admin/tenants", {
    data: {},
    headers: { "X-Admin-Token": "test-admin-token" },
  });
  if (!adminRes.ok()) {
    throw new Error(
      `POST /admin/tenants failed (${adminRes.status()}): ${await adminRes.text()}`,
    );
  }
  const { inviteUrl } = (await adminRes.json()) as { inviteUrl: string };
  const slug = base64url(randomBytes(8));
  await page.goto(inviteUrl);
  await page.getByLabel("Email").fill(`other-${slug}@cookbook.test`);
  await page.getByLabel("Display name").fill(`Other Cook ${slug}`);
  await page.getByRole("textbox", { name: "Password" }).fill("cookbook-other-password");
  await page.getByRole("button", { name: "Create account & join" }).click();
  await page.waitForURL("/");
  const result = await runOAuthFlow(page);
  if (!result.ok) throw new Error("flow failed");
  return result.tokens.accessToken;
}

/**
 * Tiny in-process HTTP server, used as a known-good source for `photoUrl`
 * (and as a known-non-image source for the bad-photo case).
 */
function startTinyServer(handler: (path: string) => { status: number; body: Buffer | string; type: string }): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const result = handler(req.url ?? "/");
      res.writeHead(result.status, { "content-type": result.type });
      res.end(result.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test.describe("MCP server", () => {
  test("add_recipe happy path (no photo)", async ({ page, flat }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    const callResult = await client.callTool({
      name: "kochbuch_add_recipe",
      arguments: {
        name: "MCP Pancakes",
        baseQuantity: 4,
        ingredients: [
          { amount: "200", unit: "g", item: "flour" },
          { amount: "300", unit: "ml", item: "milk" },
          { item: "salt" },
        ],
        steps: "Mix and fry.",
      },
    });
    expect(callResult.isError).toBeFalsy();
    const addBody = recipeRefFromToolResult(callResult);
    expect(addBody.url).toContain(`/recipes/${addBody.id}`);
    await client.close();

    await page.goto("/");
    await expect(page.getByText("MCP Pancakes")).toBeVisible();
  });

  test("add_recipe with photoUrl stores the image", async ({ page, flat }) => {
    const { server, baseUrl } = await startTinyServer(() => ({
      status: 200,
      body: TINY_PNG,
      type: "image/png",
    }));
    try {
      await login(page, flat.user);
      const result = await runOAuthFlow(page);
      if (!result.ok) throw new Error("flow failed");
      const client = await mcpClient(result.tokens.accessToken);

      const callResult = await client.callTool({
        name: "kochbuch_add_recipe",
        arguments: {
          name: "MCP Photo Recipe",
          baseQuantity: 2,
          ingredients: [{ item: "water" }],
          photoUrl: `${baseUrl}/img.png`,
        },
      });
      expect(callResult.isError).toBeFalsy();
      await client.close();

      await page.goto("/");
      await page.getByText("MCP Photo Recipe").click();
      await expect(page.getByRole("img", { name: /MCP Photo Recipe/i })).toBeVisible();
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  test("add_recipe rejects non-image photoUrl", async ({ page, flat }) => {
    const { server, baseUrl } = await startTinyServer(() => ({
      status: 200,
      body: "not an image",
      type: "text/plain",
    }));
    try {
      await login(page, flat.user);
      const result = await runOAuthFlow(page);
      if (!result.ok) throw new Error("flow failed");
      const client = await mcpClient(result.tokens.accessToken);

      const callResult = await client.callTool({
        name: "kochbuch_add_recipe",
        arguments: {
          name: "Should Not Exist",
          baseQuantity: 1,
          ingredients: [{ item: "x" }],
          photoUrl: `${baseUrl}/not-image.txt`,
        },
      });
      expect(callResult.isError).toBe(true);
      await client.close();

      await page.goto("/");
      await expect(page.getByText("Should Not Exist")).toHaveCount(0);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  test("add_recipe rejects empty ingredients", async ({ page, flat }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    // SDK validates the inputSchema and returns an error result.
    const callResult = await client.callTool({
      name: "kochbuch_add_recipe",
      arguments: {
        name: "Empty",
        baseQuantity: 1,
        ingredients: [],
      },
    });
    expect(callResult.isError).toBe(true);
    await client.close();
  });

  test("search_recipes returns matches, empty results, and respects limit", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    await addRecipeViaMcp(client, {
      name: "Pasta al limone",
      ingredients: [{ item: "spaghetti" }],
    });
    await addRecipeViaMcp(client, {
      name: "Chicken curry",
      ingredients: [{ item: "chicken" }],
    });
    await addRecipeViaMcp(client, {
      name: "Sourdough loaf",
      ingredients: [{ item: "flour" }],
      sourceUrl: "https://kingarthur.example.com/loaf",
    });

    const byName = await client.callTool({
      name: "kochbuch_search_recipes",
      arguments: { query: "chick", limit: 1 },
    });
    expect(byName.isError).toBeFalsy();
    const byNameBody = jsonFromToolResult<{
      results: Array<{ name: string; url: string; publicUrl: string }>;
    }>(byName);
    expect(byNameBody.results).toHaveLength(1);
    expect(byNameBody.results[0]?.name).toBe("Chicken curry");
    expect(byNameBody.results[0]?.url).toContain("/recipes/");
    expect(byNameBody.results[0]?.publicUrl).toContain("/r/");

    const bySource = await client.callTool({
      name: "kochbuch_search_recipes",
      arguments: { query: "kingarthur", limit: 5 },
    });
    expect(bySource.isError).toBeFalsy();
    const bySourceBody = jsonFromToolResult<{ results: Array<{ name: string }> }>(bySource);
    expect(bySourceBody.results.map((recipe) => recipe.name)).toEqual(["Sourdough loaf"]);

    const miss = await client.callTool({
      name: "kochbuch_search_recipes",
      arguments: { query: "nothingmatchesthis", limit: 5 },
    });
    expect(miss.isError).toBeFalsy();
    expect(jsonFromToolResult<{ results: unknown[] }>(miss).results).toHaveLength(0);

    const limited = await client.callTool({
      name: "kochbuch_search_recipes",
      arguments: { limit: 2 },
    });
    expect(limited.isError).toBeFalsy();
    expect(jsonFromToolResult<{ results: unknown[] }>(limited).results).toHaveLength(2);

    const deterministicA = await client.callTool({
      name: "kochbuch_search_recipes",
      arguments: { limit: 10 },
    });
    expect(deterministicA.isError).toBeFalsy();
    const deterministicABody = jsonFromToolResult<{
      results: Array<{ id: string; name: string }>;
    }>(deterministicA);

    const deterministicB = await client.callTool({
      name: "kochbuch_search_recipes",
      arguments: { limit: 10 },
    });
    expect(deterministicB.isError).toBeFalsy();
    const deterministicBBody = jsonFromToolResult<{
      results: Array<{ id: string; name: string }>;
    }>(deterministicB);
    expect(deterministicBBody.results.map((recipe) => recipe.id)).toEqual(
      deterministicABody.results.map((recipe) => recipe.id),
    );

    await client.close();
  });

  test("get_recipe returns flat-owned recipes and hides other flats", async ({
    page,
    flat,
    request,
  }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    const recipeId = await addRecipeViaMcp(client, {
      name: "MCP Soup",
      baseQuantity: 4,
      ingredients: [
        { amount: "1", unit: "l", item: "water" },
        { item: "salt" },
      ],
      steps: "Boil.",
      sourceUrl: "https://example.com/soup",
    });

    const getResult = await client.callTool({
      name: "kochbuch_get_recipe",
      arguments: { id: recipeId },
    });
    expect(getResult.isError).toBeFalsy();
    const recipe = jsonFromToolResult<{
      id: string;
      name: string;
      baseQuantity: number;
      steps: string;
      sourceHost: string | null;
      photoUrl: string | null;
      ingredients: Array<{ amount: string | null; unit: string | null; item: string }>;
    }>(getResult);
    expect(recipe.id).toBe(recipeId);
    expect(recipe.name).toBe("MCP Soup");
    expect(recipe.baseQuantity).toBe(4);
    expect(recipe.steps).toBe("Boil.");
    expect(recipe.sourceHost).toBe("example.com");
    expect(recipe.photoUrl).toBeNull();
    expect(recipe.ingredients).toEqual([
      { amount: "1", unit: "l", item: "water" },
      { amount: null, unit: null, item: "salt" },
    ]);
    await client.close();

    const otherAccessToken = await createIsolatedFlatAccessToken(page, request);
    const otherClient = await mcpClient(otherAccessToken);
    const otherGet = await otherClient.callTool({
      name: "kochbuch_get_recipe",
      arguments: { id: recipeId },
    });
    expect(otherGet.isError).toBe(true);
    expect(textFromToolResult(otherGet)).toBe("Recipe not found.");
    await otherClient.close();
  });

  test("edit_recipe patches recipe fields and replaces ingredients", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    const recipeId = await addRecipeViaMcp(client, {
      name: "Old Name",
      baseQuantity: 2,
      ingredients: [{ amount: "1", unit: "cup", item: "rice" }],
      steps: "Old steps",
    });

    const editName = await client.callTool({
      name: "kochbuch_edit_recipe",
      arguments: { id: recipeId, name: "New Name" },
    });
    expect(editName.isError).toBeFalsy();
    expect(recipeRefFromToolResult(editName)).toEqual({
      id: recipeId,
      url: `${BASE_URL}/recipes/${recipeId}`,
    });

    const editIngredients = await client.callTool({
      name: "kochbuch_edit_recipe",
      arguments: {
        id: recipeId,
        ingredients: [
          { amount: "200", unit: "g", item: "pasta" },
          { item: "pepper" },
        ],
      },
    });
    expect(editIngredients.isError).toBeFalsy();
    expect(recipeRefFromToolResult(editIngredients)).toEqual({
      id: recipeId,
      url: `${BASE_URL}/recipes/${recipeId}`,
    });

    await client.close();

    await page.goto(`/recipes/${recipeId}`);
    await expect(page.getByRole("heading", { name: "New Name" })).toBeVisible();
    await expect(page.getByText("200 g pasta")).toBeVisible();
    await expect(page.getByText("pepper")).toBeVisible();
    await expect(page.getByText("1 cup rice")).toHaveCount(0);
  });

  test("edit_recipe can add and remove a photo", async ({ page, flat }) => {
    const { server, baseUrl } = await startTinyServer(() => ({
      status: 200,
      body: TINY_PNG,
      type: "image/png",
    }));
    try {
      await login(page, flat.user);
      const result = await runOAuthFlow(page);
      if (!result.ok) throw new Error("flow failed");
      const client = await mcpClient(result.tokens.accessToken);

      const recipeId = await addRecipeViaMcp(client, {
        name: "Photo Patch",
        ingredients: [{ item: "water" }],
      });

      const addPhoto = await client.callTool({
        name: "kochbuch_edit_recipe",
        arguments: { id: recipeId, photoUrl: `${baseUrl}/img.png` },
      });
      expect(addPhoto.isError).toBeFalsy();
      expect(recipeRefFromToolResult(addPhoto)).toEqual({
        id: recipeId,
        url: `${BASE_URL}/recipes/${recipeId}`,
      });
      const getAfterAddPhoto = await client.callTool({
        name: "kochbuch_get_recipe",
        arguments: { id: recipeId },
      });
      expect(getAfterAddPhoto.isError).toBeFalsy();
      expect(jsonFromToolResult<{ photoUrl: string | null }>(getAfterAddPhoto).photoUrl).toContain(
        `/r/${recipeId}/photo`,
      );

      await page.goto(`/recipes/${recipeId}`);
      await expect(page.getByRole("img", { name: /Photo Patch/i })).toBeVisible();

      const removePhoto = await client.callTool({
        name: "kochbuch_edit_recipe",
        arguments: { id: recipeId, removePhoto: true },
      });
      expect(removePhoto.isError).toBeFalsy();
      expect(recipeRefFromToolResult(removePhoto)).toEqual({
        id: recipeId,
        url: `${BASE_URL}/recipes/${recipeId}`,
      });
      const getAfterRemovePhoto = await client.callTool({
        name: "kochbuch_get_recipe",
        arguments: { id: recipeId },
      });
      expect(getAfterRemovePhoto.isError).toBeFalsy();
      expect(jsonFromToolResult<{ photoUrl: string | null }>(getAfterRemovePhoto).photoUrl).toBeNull();
      await client.close();

      await page.goto(`/recipes/${recipeId}`);
      await expect(page.getByRole("img", { name: /Photo Patch/i })).toHaveCount(0);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });

  test("edit_recipe rejects cross-flat access and conflicting photo options", async ({
    page,
    flat,
    request,
  }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    const recipeId = await addRecipeViaMcp(client, {
      name: "Private Recipe",
      ingredients: [{ item: "water" }],
    });

    const conflicting = await client.callTool({
      name: "kochbuch_edit_recipe",
      arguments: {
        id: recipeId,
        photoUrl: "https://example.com/photo.png",
        removePhoto: true,
      },
    });
    expect(conflicting.isError).toBe(true);
    expect(textFromToolResult(conflicting)).toBe(
      "photoUrl and removePhoto cannot be used together.",
    );
    await client.close();

    const otherAccessToken = await createIsolatedFlatAccessToken(page, request);
    const otherClient = await mcpClient(otherAccessToken);
    const otherEdit = await otherClient.callTool({
      name: "kochbuch_edit_recipe",
      arguments: { id: recipeId, name: "Should Not Work" },
    });
    expect(otherEdit.isError).toBe(true);
    expect(textFromToolResult(otherEdit)).toBe("Recipe not found.");
    await otherClient.close();
  });

  test("search_recipes works with no arguments at all", async ({ page, flat }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    await addRecipeViaMcp(client, { name: "Only Recipe" });

    // Repro: Copilot was observed calling search with empty arguments.
    // Both `arguments: {}` and a fully omitted arguments field should work
    // and return recent recipes (limit defaults to 20, query defaults to "").
    const empty = await client.callTool({
      name: "kochbuch_search_recipes",
      arguments: {},
    });
    expect(empty.isError).toBeFalsy();
    const emptyBody = jsonFromToolResult<{
      query: string;
      results: Array<{ name: string }>;
    }>(empty);
    expect(emptyBody.query).toBe("");
    expect(emptyBody.results.map((r) => r.name)).toContain("Only Recipe");

    const missing = await client.callTool({
      name: "kochbuch_search_recipes",
    });
    expect(missing.isError).toBeFalsy();
    expect(
      jsonFromToolResult<{ results: Array<{ name: string }> }>(missing).results.map(
        (r) => r.name,
      ),
    ).toContain("Only Recipe");

    await client.close();
  });

  test("edit_recipe accepts ingredients and baseQuantity together", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");
    const client = await mcpClient(result.tokens.accessToken);

    const recipeId = await addRecipeViaMcp(client, {
      name: "Combo Edit",
      baseQuantity: 2,
      ingredients: [{ amount: "1", unit: "cup", item: "rice" }],
    });

    // Repro: Copilot was observed editing a recipe with both ingredients
    // and baseQuantity in the same call.
    const editBoth = await client.callTool({
      name: "kochbuch_edit_recipe",
      arguments: {
        id: recipeId,
        baseQuantity: 6,
        ingredients: [
          { amount: "1", unit: "cup", item: "rice" },
          { amount: "2", unit: "tbsp", item: "soy sauce" },
        ],
      },
    });
    expect(editBoth.isError).toBeFalsy();
    expect(recipeRefFromToolResult(editBoth)).toEqual({
      id: recipeId,
      url: `${BASE_URL}/recipes/${recipeId}`,
    });
    const getEdited = await client.callTool({
      name: "kochbuch_get_recipe",
      arguments: { id: recipeId },
    });
    expect(getEdited.isError).toBeFalsy();
    const body = jsonFromToolResult<{
      baseQuantity: number;
      ingredients: Array<{ amount: string | null; unit: string | null; item: string }>;
    }>(getEdited);
    expect(body.baseQuantity).toBe(6);
    expect(body.ingredients).toEqual([
      { amount: "1", unit: "cup", item: "rice" },
      { amount: "2", unit: "tbsp", item: "soy sauce" },
    ]);

    await client.close();
  });

  test("/mcp returns 401 + WWW-Authenticate without a bearer", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
  });

  test("oauth-protected-resource metadata is served at both the bare and path-suffixed URLs", async () => {
    // RFC 9728 §3.1 / MCP 2025-06-18: clients construct the metadata URL by
    // appending the resource path to `.well-known/oauth-protected-resource`.
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status, `${path} should respond 200`).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const body = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
      };
      expect(body.resource).toBe(`${BASE_URL}/mcp`);
      expect(body.authorization_servers).toEqual([BASE_URL]);
    }
  });

  test("authorization-server metadata is served at oauth-authorization-server and openid-configuration", async () => {
    // Some MCP clients (e.g. Claude) probe /.well-known/openid-configuration
    // first before falling back to /.well-known/oauth-authorization-server.
    // Both must return the same AS metadata so DCR can proceed.
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]) {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status, `${path} should respond 200`).toBe(200);
      const body = (await res.json()) as {
        issuer: string;
        registration_endpoint: string;
        authorization_endpoint: string;
        token_endpoint: string;
      };
      expect(body.issuer).toBe(BASE_URL);
      expect(body.registration_endpoint).toBe(`${BASE_URL}/oauth/register`);
      expect(body.authorization_endpoint).toBe(`${BASE_URL}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${BASE_URL}/oauth/token`);
    }
  });

  test("dynamic client registration is reachable at both /oauth/register and /register", async () => {
    // Some MCP clients (e.g. Claude) hardcode a bare /register endpoint as a
    // DCR fallback instead of honoring the advertised registration_endpoint.
    // Both paths must succeed so the OAuth flow can start.
    for (const path of ["/oauth/register", "/register"]) {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: `probe ${path}`,
          redirect_uris: ["https://example.test/cb"],
        }),
      });
      expect(res.status, `${path} should 201`).toBe(201);
      const body = (await res.json()) as { client_id: string };
      expect(body.client_id).toMatch(/^mcp_/);
    }
  });

  test("refresh token rotates and revokes the old one", async ({ page, flat }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page);
    if (!result.ok) throw new Error("flow failed");

    const refresh = async (token: string) =>
      fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: result.tokens.clientId,
        }).toString(),
      });

    const r1 = await refresh(result.tokens.refreshToken);
    expect(r1.ok).toBe(true);
    const r1Body = (await r1.json()) as { access_token: string; refresh_token: string };

    // Old refresh is now revoked.
    const r2 = await refresh(result.tokens.refreshToken);
    expect(r2.status).toBe(400);

    // New access token works.
    const client = await mcpClient(r1Body.access_token);
    const callResult = await client.callTool({
      name: "kochbuch_add_recipe",
      arguments: {
        name: "After Refresh",
        baseQuantity: 1,
        ingredients: [{ item: "tea" }],
      },
    });
    expect(callResult.isError).toBeFalsy();
    await client.close();
  });

  test("deny on the consent screen returns access_denied", async ({ page, flat }) => {
    await login(page, flat.user);
    const result = await runOAuthFlow(page, { decision: "deny" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("access_denied");
    }
  });

  test("authorize approve returns an HTTP 302 to the redirect_uri (not a single-fetch 202)", async ({
    page,
    flat,
  }) => {
    // Regression test for the OAuth handoff bug where React Router's
    // <Form> submitted to /oauth/authorize.data and encoded the redirect
    // to the external redirect_uri (e.g. https://claude.ai/...) as a 202
    // single-fetch response that webview-based OAuth clients couldn't
    // follow. The authorize endpoint must respond with a real top-level
    // HTTP 302 so the browser follows it natively.
    await login(page, flat.user);
    const catcher = await startRedirectCatcher();
    try {
      const { clientId } = await registerClient(catcher.url);
      const { challenge } = pkce();
      const state = base64url(randomBytes(16));

      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: catcher.url,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "recipes:write",
      });

      // GET the consent page so we can read the CSRF token out of the form.
      const consentRes = await page.request.get(
        `/oauth/authorize?${params.toString()}`,
      );
      expect(consentRes.status()).toBe(200);
      const html = await consentRes.text();
      const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
      if (!csrfMatch) throw new Error("could not find csrf token in consent page");
      const csrf = csrfMatch[1];

      // POST the approval and ensure we get a top-level 302 redirect to
      // the redirect_uri carrying the code+state, not a 202 single-fetch
      // response.
      const postRes = await page.request.post(
        `/oauth/authorize?${params.toString()}`,
        {
          form: { _csrf: csrf, query_string: params.toString(), decision: "approve" },
          headers: { origin: BASE_URL },
          maxRedirects: 0,
        },
      );
      expect(postRes.status()).toBe(302);
      const location = postRes.headers()["location"] ?? "";
      const locUrl = new URL(location);
      expect(`${locUrl.origin}${locUrl.pathname}`).toBe(catcher.url);
      expect(locUrl.searchParams.get("state")).toBe(state);
      expect(locUrl.searchParams.get("code")).toBeTruthy();
    } finally {
      await catcher.close();
    }
  });
});
