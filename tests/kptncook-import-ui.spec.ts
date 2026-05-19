import { test, expect } from "./fixtures";
import { login } from "./login";
import { MOCK_RECIPES } from "./proxy/fixtures.mjs";

const SHARE_URL = `https://share.kptncook.com/${MOCK_RECIPES.cinnamonBuns.shareToken}`;

test.describe("kptncook import", () => {
  test("UI: paste share URL → form prefilled → save creates the recipe", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    await page.goto("/recipes/new");

    await page.getByRole("button", { name: /import from kptncook/i }).click();
    await expect(
      page.getByRole("heading", { name: /import a kptncook recipe/i }),
    ).toBeVisible();

    await page.getByLabel("Share URL or id").fill(SHARE_URL);
    await page.getByRole("button", { name: "Import", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: /import a kptncook recipe/i }),
    ).toBeHidden();

    // Form fields are prefilled.
    await expect(page.getByLabel("Name")).toHaveValue("Zimtschnecken");
    await expect(page.getByLabel("Source URL")).toHaveValue(
      `https://share.kptncook.com/${MOCK_RECIPES.cinnamonBuns.uid}`,
    );

    await expect(page.getByLabel("Ingredient 1 amount")).toHaveValue("250");
    await expect(page.getByLabel("Ingredient 1 unit")).toHaveValue("g");
    await expect(page.getByLabel("Ingredient 1 item")).toHaveValue("Mehl");
    await expect(page.getByLabel("Ingredient 2 amount")).toHaveValue("150");
    await expect(page.getByLabel("Ingredient 2 unit")).toHaveValue("ml");
    await expect(page.getByLabel("Ingredient 2 item")).toHaveValue("Milch");
    await expect(page.getByLabel("Ingredient 3 amount")).toHaveValue("2");
    await expect(page.getByLabel("Ingredient 3 item")).toHaveValue("Eier");

    await expect(page.getByLabel("Steps")).toHaveValue(
      /Teig anrühren.*Zimt-Zucker.*180 °C/s,
    );

    // The imported photo shows as a preview thumbnail.
    await expect(page.getByAltText("Current photo")).toBeVisible();

    await page.getByRole("button", { name: "Save recipe" }).click();

    await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: "Zimtschnecken" }),
    ).toBeVisible();
    await expect(page.getByText("250 g Mehl")).toBeVisible();
    await expect(page.getByText("150 ml Milch")).toBeVisible();
    await expect(page.getByText("2 Eier")).toBeVisible();

    // The imported photo lands on the recipe detail view (the recipe
    // would only have a <img> if photoBlobKey was set).
    await expect(page.locator("img").first()).toBeVisible();
  });

  test("UI: bogus input → modal shows error and stays open", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    await page.goto("/recipes/new");
    await page.getByRole("button", { name: /import from kptncook/i }).click();
    await page.getByLabel("Share URL or id").fill("nope-not-an-id");
    await page.getByRole("button", { name: "Import", exact: true }).click();

    await expect(page.getByRole("alert")).toContainText(/kptncook/i);
    await expect(
      page.getByRole("heading", { name: /import a kptncook recipe/i }),
    ).toBeVisible();
  });
});
