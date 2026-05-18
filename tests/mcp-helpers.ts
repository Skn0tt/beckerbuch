import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = "http://localhost:8888";

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

export type OAuthResult = {
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
export async function runOAuthFlow(
  page: Page,
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
    const buttonName = opts.decision === "approve" ? "Approve" : "Deny";
    await page.getByRole("button", { name: buttonName }).click();

    const cap = await catcher.waitForCode();
    if (cap.searchParams.get("state") !== state) {
      throw new Error("state mismatch");
    }

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

export async function mcpClient(accessToken: string): Promise<Client> {
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

export function textFromToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("tool result did not contain text");
  return text;
}

export function jsonFromToolResult<TResult>(
  result: Awaited<ReturnType<Client["callTool"]>>,
): TResult {
  return JSON.parse(textFromToolResult(result)) as TResult;
}
