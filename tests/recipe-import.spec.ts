import { test, expect } from "./fixtures";
import { login } from "./login";
import {
  runOAuthFlow,
  mcpClient,
  jsonFromToolResult,
  setMcpBaseUrl,
} from "./mcp-helpers";
import { cannedRecipePagesHandler } from "./mock-handlers";
import {
  BBC_BAKED_RATATOUILLE,
  CANNED_COVER_JPEG,
  CANNED_NO_RECIPE_HTML,
  CANNED_NO_RECIPE_URL,
  CANNED_RECIPE_PAGES,
  CANNED_SCHEMA_ORG_HOSTS,
} from "./schema-org-pages";

/**
 * MCP import tests for schema.org Recipe JSON-LD. Page HTML and cover
 * photos are canned fixtures served by the test proxy — the specs do
 * not fetch those hosts.
 */

type FetchResult = {
  name: string;
  baseQuantity: number;
  sourceUrl: string | null;
  steps: string;
  ingredients: Array<{
    amount: string | null;
    unit: string | null;
    item: string;
  }>;
  photo: { contentType: string; base64: string } | null;
  note?: string;
};

test.describe("generic recipe import", () => {
  test.beforeEach(async ({ mocks, baseURL }) => {
    setMcpBaseUrl(baseURL!);
    await mocks.route(
      CANNED_SCHEMA_ORG_HOSTS,
      cannedRecipePagesHandler(
        [
          ...CANNED_RECIPE_PAGES,
          BBC_BAKED_RATATOUILLE,
          { pageUrl: CANNED_NO_RECIPE_URL, html: CANNED_NO_RECIPE_HTML },
        ],
        CANNED_COVER_JPEG,
      ),
    );
  });

  for (const recipe of CANNED_RECIPE_PAGES) {
    test(`fetch_recipe imports ${recipe.label}`, async ({ page, flat }) => {
      await login(page, flat.user);
      const oauth = await runOAuthFlow(page);
      if (!oauth.ok) throw new Error("oauth flow failed");
      const client = await mcpClient(oauth.tokens.accessToken);

      try {
        const callResult = await client.callTool({
          name: "fetch_recipe",
          arguments: { input: recipe.pageUrl },
        });
        expect(
          callResult.isError,
          JSON.stringify(callResult.content),
        ).toBeFalsy();

        const data = jsonFromToolResult<FetchResult>(callResult);

        expect(data.name).toMatch(recipe.nameRe);
        expect(data.baseQuantity).toBeGreaterThanOrEqual(1);
        expect(data.baseQuantity).toBeLessThanOrEqual(1000);

        // Source host points back at the origin site.
        expect(data.sourceUrl).toBeTruthy();
        expect(new URL(data.sourceUrl!).host).toMatch(recipe.hostRe);

        // Ingredients: enough of them, every line has a non-empty item,
        // and at least one parsed into a numeric amount.
        expect(data.ingredients.length).toBeGreaterThanOrEqual(
          recipe.minIngredients,
        );
        for (const ing of data.ingredients) {
          expect(ing.item.trim().length).toBeGreaterThan(0);
        }
        const withAmount = data.ingredients.filter((i) => i.amount !== null);
        expect(withAmount.length).toBeGreaterThan(0);

        // Steps are present and came from the canned page, not the live site.
        expect(data.steps.trim().length).toBeGreaterThan(0);
        expect(data.steps).toContain(recipe.stepMarker);

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
        arguments: { input: CANNED_NO_RECIPE_URL },
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
      // assertPublicUrl rejects localhost before any fetch.
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
