import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { test, expect } from "./fixtures";
import { login } from "./login";
import {
  getBaseUrl,
  getMcpUrlFromSettings,
  jsonFromToolResult,
  mcpClient,
  mcpClientFor,
  setMcpBaseUrl,
  textFromToolResult,
} from "./mcp-helpers";

test.beforeEach(({ baseURL }) => {
  if (!baseURL) throw new Error("baseURL fixture not set");
  setMcpBaseUrl(baseURL);
});

// Smallest possible valid PNG: 1x1 transparent pixel.
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000156a4179f0000000049454e44ae426082",
  "hex",
);

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

/**
 * Provision a second, isolated flat + user via the admin endpoint and
 * the public invite-redemption form, then return an MCP client wired
 * to that user's per-user token. Mirrors the `flat` fixture but for
 * "the other tenant" in cross-flat isolation tests.
 */
async function createIsolatedFlatMcpClient(
  page: Page,
  request: APIRequestContext,
): Promise<Client> {
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
  const slug = randomUUID().slice(0, 8);
  const otherUser = {
    email: `other-${slug}@cookbook.test`,
    displayName: `Other Cook ${slug}`,
    password: "cookbook-other-password",
  };
  await page.goto(inviteUrl);
  await page.getByLabel("Email").fill(otherUser.email);
  await page.getByLabel("Display name").fill(otherUser.displayName);
  await page
    .getByRole("textbox", { name: "Password" })
    .fill(otherUser.password);
  await page.getByRole("button", { name: "Create account & join" }).click();
  await page.waitForURL("/");
  // Already logged in as `otherUser` from invite redemption — go grab
  // the URL from settings directly.
  await page.goto("/flat/settings");
  const url = await page.getByLabel("MCP URL").inputValue();
  return mcpClient(url);
}

/**
 * Tiny in-process HTTP server, used as a known-good source for `photoUrl`
 * (and as a known-non-image source for the bad-photo case).
 */
function startTinyServer(
  handler: (path: string) => { status: number; body: Buffer | string; type: string },
): Promise<{ server: Server; baseUrl: string }> {
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
    const client = await mcpClientFor(page, flat.user);

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
      const client = await mcpClientFor(page, flat.user);

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
      const client = await mcpClientFor(page, flat.user);

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
    const client = await mcpClientFor(page, flat.user);

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
    const client = await mcpClientFor(page, flat.user);

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
    const client = await mcpClientFor(page, flat.user);

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

    const otherClient = await createIsolatedFlatMcpClient(page, request);
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
    const baseURL = getBaseUrl();
    const client = await mcpClientFor(page, flat.user);

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
      url: `${baseURL}/recipes/${recipeId}`,
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
      url: `${baseURL}/recipes/${recipeId}`,
    });

    await client.close();

    await page.goto(`/recipes/${recipeId}`);
    await expect(page.getByRole("heading", { name: "New Name" })).toBeVisible();
    await expect(page.getByText("200 g pasta")).toBeVisible();
    await expect(page.getByText("pepper")).toBeVisible();
    await expect(page.getByText("1 cup rice")).toHaveCount(0);
  });

  test("edit_recipe can add and remove a photo", async ({ page, flat }) => {
    const baseURL = getBaseUrl();
    const { server, baseUrl } = await startTinyServer(() => ({
      status: 200,
      body: TINY_PNG,
      type: "image/png",
    }));
    try {
      const client = await mcpClientFor(page, flat.user);

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
        url: `${baseURL}/recipes/${recipeId}`,
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
        url: `${baseURL}/recipes/${recipeId}`,
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
    const client = await mcpClientFor(page, flat.user);

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

    const otherClient = await createIsolatedFlatMcpClient(page, request);
    const otherEdit = await otherClient.callTool({
      name: "kochbuch_edit_recipe",
      arguments: { id: recipeId, name: "Should Not Work" },
    });
    expect(otherEdit.isError).toBe(true);
    expect(textFromToolResult(otherEdit)).toBe("Recipe not found.");
    await otherClient.close();
  });

  test("search_recipes works with no arguments at all", async ({ page, flat }) => {
    const client = await mcpClientFor(page, flat.user);

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
    const baseURL = getBaseUrl();
    const client = await mcpClientFor(page, flat.user);

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
      url: `${baseURL}/recipes/${recipeId}`,
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

  test("Bearer header is accepted as a fallback to ?token=", async ({
    page,
    flat,
  }) => {
    // Some MCP clients hide query strings from request logs or only do
    // header auth — the same UUID via Authorization: Bearer should work.
    const baseURL = getBaseUrl();
    const url = await getMcpUrlFromSettings(page, flat.user);
    const token = new URL(url).searchParams.get("token");
    if (!token) throw new Error("settings URL had no token param");

    const res = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bearer-probe", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  test("/mcp returns 401 with plain JSON and no WWW-Authenticate", async () => {
    const baseURL = getBaseUrl();
    const res = await fetch(`${baseURL}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("/mcp returns 401 for an unknown or malformed token", async () => {
    const baseURL = getBaseUrl();
    for (const token of ["not-a-uuid", randomUUID()]) {
      const res = await fetch(`${baseURL}/mcp?token=${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(res.status, `token=${token}`).toBe(401);
    }
  });

  test("MCP URL shown on /flat/settings includes a UUID token", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    await page.goto("/flat/settings");
    const url = await page.getByLabel("MCP URL").inputValue();
    expect(url).toMatch(/\/mcp\?token=[0-9a-f-]{36}$/);
  });
});
