import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { login } from "./login";
import type { TestUser } from "./fixtures";

// Set per-test from outside via setMcpBaseUrl(); see callsites'
// test.beforeEach. Keeping it module-scope avoids threading baseURL
// through every helper signature.
let BASE_URL = "";

export function setMcpBaseUrl(url: string) {
  BASE_URL = url;
}

/**
 * Log in as `user`, drive the flat-settings UI, and return the MCP URL
 * (including `?token=<uuid>`) that the settings page exposes for that
 * user. This mirrors how a human would set up the integration: copy
 * the URL from settings, paste it into an MCP client.
 */
export async function getMcpUrlFromSettings(
  page: Page,
  user: TestUser,
): Promise<string> {
  await login(page, user);
  await page.goto("/flat/settings");
  const url = await page.getByLabel("MCP URL").inputValue();
  if (!url) throw new Error("MCP URL field was empty");
  return url;
}

/**
 * Open an MCP client transport against `urlWithToken` — either the URL
 * the settings page renders (token already in the query string), or a
 * bare `${BASE_URL}/mcp` if you're testing the unauthorized path
 * yourself.
 */
export async function mcpClient(urlWithToken: string): Promise<Client> {
  const client = new Client(
    { name: "playwright-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(urlWithToken));
  await client.connect(transport);
  return client;
}

/** Convenience: log in as `user`, fetch their MCP URL, open a client. */
export async function mcpClientFor(
  page: Page,
  user: TestUser,
): Promise<Client> {
  const url = await getMcpUrlFromSettings(page, user);
  return mcpClient(url);
}

export function getBaseUrl(): string {
  if (!BASE_URL) throw new Error("setMcpBaseUrl was not called");
  return BASE_URL;
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
