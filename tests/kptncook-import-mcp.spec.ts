import { test, expect } from "./fixtures";
import { login } from "./login";
import {
  runOAuthFlow,
  mcpClient,
  jsonFromToolResult,
  setMcpBaseUrl,
} from "./mcp-helpers";
import { MOCK_RECIPES } from "./mock-data";
import {
  kptncookShareRedirectHandler,
  kptncookSearchHandler,
  kptncookImagesHandler,
} from "./mock-handlers";

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

const SHARE_URL = `https://share.kptncook.com/${MOCK_RECIPES.cinnamonBuns.shareToken}`;

test.describe("MCP fetch_recipe", () => {
  test.beforeEach(async ({ mocks, baseURL }) => {
    setMcpBaseUrl(baseURL!);
    const recipes = [MOCK_RECIPES.cinnamonBuns];
    await mocks.route(
      /^https:\/\/share\.kptncook\.com\/[^/]+$/,
      kptncookShareRedirectHandler(recipes),
    );
    await mocks.route(
      "https://mobile.kptncook.com/recipes/search**",
      kptncookSearchHandler(recipes),
    );
    await mocks.route(
      /^https:\/\/mobile\.kptncook\.com\/images\/.+/,
      kptncookImagesHandler(),
    );
  });

  test("returns normalized payload for a share URL", async ({ page, flat }) => {
    await login(page, flat.user);
    const oauth = await runOAuthFlow(page);
    if (!oauth.ok) throw new Error("oauth flow failed");
    const client = await mcpClient(oauth.tokens.accessToken);

    try {
      const callResult = await client.callTool({
        name: "fetch_recipe",
        arguments: { input: SHARE_URL },
      });
      expect(callResult.isError).toBeFalsy();

      const data = jsonFromToolResult<FetchResult>(callResult);
      expect(data.name).toBe("Zimtschnecken");
      expect(data.baseQuantity).toBe(1);
      expect(data.sourceUrl).toBe(
        `https://share.kptncook.com/${MOCK_RECIPES.cinnamonBuns.uid}`,
      );
      expect(data.ingredients).toEqual([
        { amount: "250", unit: "g", item: "Mehl" },
        { amount: "150", unit: "ml", item: "Milch" },
        { amount: "2", unit: null, item: "Eier" },
      ]);
      expect(data.steps).toBe(
        [
          "Teig anrühren und 15 Min. ruhen lassen.",
          "Zimt-Zucker-Füllung verteilen, rollen und 30–40 Min. gehen lassen.",
          "Bei 180 °C backen, höchstens bis zu 25 Min.",
        ].join("\n\n"),
      );
      expect(data.steps).not.toMatch(/<timer>/);
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
        name: "fetch_recipe",
        arguments: {
          input: MOCK_RECIPES.cinnamonBuns.uid,
          includePhoto: false,
        },
      });
      expect(callResult.isError).toBeFalsy();
      const data = jsonFromToolResult<FetchResult>(callResult);
      expect(data.name).toBe("Zimtschnecken");
      expect(data.photo).toBeNull();
    } finally {
      await client.close();
    }
  });

  test("add_recipe stores the cover fetch_recipe already downloaded", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    const oauth = await runOAuthFlow(page);
    if (!oauth.ok) throw new Error("oauth flow failed");
    const client = await mcpClient(oauth.tokens.accessToken);

    try {
      const fetched = await client.callTool({
        name: "fetch_recipe",
        arguments: { input: SHARE_URL },
      });
      expect(fetched.isError).toBeFalsy();
      const data = jsonFromToolResult<FetchResult>(fetched);
      expect(data.photo).not.toBeNull();
      expect(data.note ?? "").not.toMatch(/cannot be carried/i);
      expect(data.note).toContain("photo argument");

      const added = await client.callTool({
        name: "kochbuch_add_recipe",
        arguments: {
          name: data.name,
          baseQuantity: data.baseQuantity,
          steps: data.steps,
          sourceUrl: data.sourceUrl,
          ingredients: data.ingredients.map((ingredient) => ({
            ...(ingredient.amount ? { amount: ingredient.amount } : {}),
            ...(ingredient.unit ? { unit: ingredient.unit } : {}),
            item: ingredient.item,
          })),
          photo: data.photo,
        },
      });
      expect(added.isError, JSON.stringify(added.content)).toBeFalsy();
      const { id } = jsonFromToolResult<{ id: string; url: string }>(added);

      const got = await client.callTool({
        name: "kochbuch_get_recipe",
        arguments: { id },
      });
      expect(got.isError).toBeFalsy();
      const photoUrl = jsonFromToolResult<{ photoUrl: string | null }>(
        got,
      ).photoUrl;
      expect(photoUrl).toContain(`/r/${id}/photo`);
      const img = await page.request.get(photoUrl!);
      expect(img.ok()).toBeTruthy();
      expect(img.headers()["content-type"]).toContain("image/jpeg");
      expect(
        Buffer.from(await img.body()).equals(
          Buffer.from(data.photo!.base64, "base64"),
        ),
      ).toBe(true);

      // The canned kptncook cover is a 1×1 JPEG that Chromium does not
      // decode, so the grid check is the photo img (not the grey initial).
      await page.goto("/");
      const cover = page.getByRole("img", { name: "Zimtschnecken" });
      await expect(cover).toBeVisible();
      await expect(cover).toHaveAttribute(
        "src",
        new RegExp(`/recipes/${id}/photo`),
      );
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
        name: "fetch_recipe",
        arguments: { input: "not-a-real-id" },
      });
      expect(callResult.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
