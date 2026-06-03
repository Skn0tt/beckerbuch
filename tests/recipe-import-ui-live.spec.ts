import { test, expect } from "./fixtures";
import { login } from "./login";

/**
 * Live UI import test: paste a real recipe URL into the import modal and
 * confirm the form pre-fills and saves. Runs against the real internet
 * (proxy pass-through), so assertions stay loose — see
 * recipe-import-live.spec.ts for rationale.
 */

const LIVE_URL = "https://www.loveandlemons.com/banana-bread/";

test.describe("generic recipe import (live UI)", () => {
  test.slow();

  test("paste recipe URL → form prefilled → save creates the recipe", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    await page.goto("/recipes/new");

    await page.getByRole("button", { name: /import recipe/i }).click();
    await expect(
      page.getByRole("heading", { name: /import a recipe/i }),
    ).toBeVisible();

    await page.getByLabel("Recipe URL or kptncook link / id").fill(LIVE_URL);
    await page.getByRole("button", { name: "Import", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: /import a recipe/i }),
    ).toBeHidden();

    // Name pre-filled from the page's JSON-LD.
    await expect(page.getByLabel("Name")).toHaveValue(/banana bread/i);
    await expect(page.getByLabel("Source URL")).toHaveValue(/loveandlemons\.com/);

    // First ingredient parsed into at least a non-empty item.
    await expect(page.getByLabel("Ingredient 1 item")).not.toHaveValue("");

    // Steps pre-filled.
    await expect(page.getByLabel("Steps")).not.toHaveValue("");

    // Imported cover photo shows as a preview thumbnail.
    await expect(page.getByAltText("Current photo")).toBeVisible();

    await page.getByRole("button", { name: "Save recipe" }).click();

    await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: /banana bread/i }),
    ).toBeVisible();
  });
});
