import { test, expect } from "./fixtures";
import { login } from "./login";
import { runOAuthFlow, mcpClient, jsonFromToolResult } from "./mcp-helpers";
import { MOCK_RECIPES } from "./proxy/fixtures.mjs";

type FetchResult = {
  name: string;
  baseQuantity: number;
  sourceUrl: string | null;
  steps: string;
  ingredients: Array<{ amount: string | null; unit: string | null; item: string }>;
  photo: { contentType: string; base64: string } | null;
  note?: string;
};

const SHARE_URL = `https://share.kptncook.com/${MOCK_RECIPES.cinnamonBuns.shareToken}`;

test.describe("MCP kptncook_fetch_recipe", () => {
  test("returns normalized payload for a share URL", async ({ page, flat }) => {
    await login(page, flat.user);
    const oauth = await runOAuthFlow(page);
    if (!oauth.ok) throw new Error("oauth flow failed");
    const client = await mcpClient(oauth.tokens.accessToken);

    try {
      const callResult = await client.callTool({
        name: "kptncook_fetch_recipe",
        arguments: { input: SHARE_URL },
      });
      expect(callResult.isError).toBeFalsy();

      const data = jsonFromToolResult<FetchResult>(callResult);
      expect(data.name).toBe("Zimtschnecken");
      expect(data.baseQuantity).toBe(2);
      expect(data.sourceUrl).toBe(
        `https://share.kptncook.com/${MOCK_RECIPES.cinnamonBuns.uid}`,
      );
      expect(data.ingredients).toEqual([
        { amount: "250", unit: "g", item: "Mehl" },
        { amount: "150", unit: "ml", item: "Milch" },
        { amount: "2", unit: null, item: "Eier" },
      ]);
      expect(data.steps).toMatch(/Teig anrühren/);
      expect(data.steps).toMatch(/180 °C/);
      expect(data.photo).not.toBeNull();
      expect(data.photo!.contentType).toBe("image/jpeg");
      expect(data.photo!.base64.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  test("works with a bare uid", async ({ page, flat }) => {
    await login(page, flat.user);
    const oauth = await runOAuthFlow(page);
    if (!oauth.ok) throw new Error("oauth flow failed");
    const client = await mcpClient(oauth.tokens.accessToken);

    try {
      const callResult = await client.callTool({
        name: "kptncook_fetch_recipe",
        arguments: { input: MOCK_RECIPES.cinnamonBuns.uid, includePhoto: false },
      });
      expect(callResult.isError).toBeFalsy();
      const data = jsonFromToolResult<FetchResult>(callResult);
      expect(data.name).toBe("Zimtschnecken");
      expect(data.photo).toBeNull();
    } finally {
      await client.close();
    }
  });

  test("returns an error result for an unparseable input", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    const oauth = await runOAuthFlow(page);
    if (!oauth.ok) throw new Error("oauth flow failed");
    const client = await mcpClient(oauth.tokens.accessToken);

    try {
      const callResult = await client.callTool({
        name: "kptncook_fetch_recipe",
        arguments: { input: "not-a-real-id" },
      });
      expect(callResult.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
