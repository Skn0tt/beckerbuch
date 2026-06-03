import { test, expect } from "./fixtures";
import { login } from "./login";
import {
  runOAuthFlow,
  mcpClient,
  jsonFromToolResult,
  setMcpBaseUrl,
} from "./mcp-helpers";

/**
 * Live import tests for arbitrary recipe pages (schema.org JSON-LD).
 *
 * These run against the REAL internet (the test proxy passes unmatched
 * requests through), so assertions are intentionally loose: third-party
 * pages change wording, counts, and photos over time. We assert the
 * shape and a few stable anchors, not exact strings.
 *
 * If one of these URLs 404s / bot-blocks / restructures, the fix is to
 * swap the URL — not to weaken the importer.
 */

type FetchResult = {
  name: string;
  baseQuantity: number;
  sourceUrl: string | null;
  steps: string;
  ingredients: Array<{ amount: string | null; unit: string | null; item: string }>;
  photo: { contentType: string; base64: string } | null;
  note?: string;
};

// Real, long-lived recipe URLs that expose schema.org Recipe JSON-LD.
// Chosen for diversity (a magazine + two WP-Recipe-Maker food blogs) and
// for currently serving without bot-blocking. If one starts 403/404ing,
// swap it for another schema.org page rather than weakening assertions.
const LIVE_RECIPES = [
  {
    label: "Bon Appétit chocolate chip cookies",
    url: "https://www.bonappetit.com/recipe/bas-best-chocolate-chip-cookies",
    nameRe: /cookie/i,
    hostRe: /bonappetit\.com$/,
    minIngredients: 5,
  },
  {
    label: "Love and Lemons banana bread",
    url: "https://www.loveandlemons.com/banana-bread/",
    nameRe: /banana bread/i,
    hostRe: /loveandlemons\.com$/,
    minIngredients: 6,
  },
  {
    label: "Sally's Baking Addiction banana bread",
    url: "https://sallysbakingaddiction.com/best-banana-bread-recipe/",
    nameRe: /banana bread/i,
    hostRe: /sallysbakingaddiction\.com$/,
    minIngredients: 6,
  },
] as const;

test.describe("generic recipe import (live)", () => {
  // Real-network requests are slower and flakier than mocked ones.
  test.slow();

  test.beforeEach(async ({ baseURL }) => {
    setMcpBaseUrl(baseURL!);
  });

  for (const recipe of LIVE_RECIPES) {
    test(`fetch_recipe imports ${recipe.label}`, async ({ page, flat }) => {
      await login(page, flat.user);
      const oauth = await runOAuthFlow(page);
      if (!oauth.ok) throw new Error("oauth flow failed");
      const client = await mcpClient(oauth.tokens.accessToken);

      try {
        const callResult = await client.callTool({
          name: "fetch_recipe",
          arguments: { input: recipe.url },
        });
        expect(callResult.isError, JSON.stringify(callResult.content)).toBeFalsy();

        const data = jsonFromToolResult<FetchResult>(callResult);

        expect(data.name).toMatch(recipe.nameRe);
        expect(data.baseQuantity).toBeGreaterThanOrEqual(1);
        expect(data.baseQuantity).toBeLessThanOrEqual(1000);

        // Source host points back at the origin site.
        expect(data.sourceUrl).toBeTruthy();
        expect(new URL(data.sourceUrl!).host).toMatch(recipe.hostRe);

        // Ingredients: enough of them, every line has a non-empty item,
        // and at least one parsed into a numeric amount + unit.
        expect(data.ingredients.length).toBeGreaterThanOrEqual(recipe.minIngredients);
        for (const ing of data.ingredients) {
          expect(ing.item.trim().length).toBeGreaterThan(0);
        }
        const withAmount = data.ingredients.filter((i) => i.amount !== null);
        expect(withAmount.length).toBeGreaterThan(0);

        // Steps are present.
        expect(data.steps.trim().length).toBeGreaterThan(0);

        // Cover photo imported.
        expect(data.photo).not.toBeNull();
        expect(data.photo!.contentType).toMatch(/^image\//);
        expect(data.photo!.base64.length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    });
  }

  test("fetch_recipe errors on a page with no recipe data", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    const oauth = await runOAuthFlow(page);
    if (!oauth.ok) throw new Error("oauth flow failed");
    const client = await mcpClient(oauth.tokens.accessToken);

    try {
      const callResult = await client.callTool({
        name: "fetch_recipe",
        arguments: { input: "https://example.com/" },
      });
      expect(callResult.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("fetch_recipe refuses to fetch a local address (SSRF guard)", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    const oauth = await runOAuthFlow(page);
    if (!oauth.ok) throw new Error("oauth flow failed");
    const client = await mcpClient(oauth.tokens.accessToken);

    try {
      const callResult = await client.callTool({
        name: "fetch_recipe",
        arguments: { input: "http://localhost/admin" },
      });
      expect(callResult.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
