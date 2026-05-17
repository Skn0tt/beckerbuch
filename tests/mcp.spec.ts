import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, expect } from "./fixtures";
import { login } from "./login";

const BASE_URL = "http://localhost:8888";

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
});
