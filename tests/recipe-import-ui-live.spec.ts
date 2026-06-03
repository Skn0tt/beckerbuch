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
    await expect(page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Item")).not.toHaveValue("");

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

  // spec: specs/recipe-import-ui-live.plan.md (1.2)
  // Asserts the import modal extracts every ingredient from a BBC Good Food
  // recipe with the exact amount, unit, and item — not just sanity counts.
  // Catches regressions where unit detection drops tbsp/tsp/ml/g, where
  // unitless counts get a spurious unit, or where the "For the cheese sauce"
  // subsection is skipped.
  test("import BBC Good Food baked ratatouille prefills exact ingredients", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);
    await page.goto("/recipes/new");

    // 1. Open the import modal.
    await page.getByRole("button", { name: /import recipe/i }).click();
    await expect(
      page.getByRole("heading", { name: /import a recipe/i }),
    ).toBeVisible();

    // 2. Paste the BBC Good Food URL and import.
    await page
      .getByLabel("Recipe URL or kptncook link / id")
      .fill("https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese");
    await page.getByRole("button", { name: "Import", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: /import a recipe/i }),
    ).toBeHidden();

    await expect(page.getByLabel("Name")).toHaveValue(/ratatouille/i);
    await expect(page.getByLabel("Source URL")).toHaveValue(/bbcgoodfood\.com/);

    // Wait for the importer to populate the form, then assert the whole
    // ingredients block as one ARIA snapshot so a single soft failure shows
    // every mismatched row, amount, unit, and item at once.
    await expect(page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Item")).not.toHaveValue("");

    await expect.soft(page.getByRole("table", { name: "Ingredients" })).toMatchAriaSnapshot(`
      - table "Ingredients":
        - rowgroup:
          - row "Amount Unit Item Actions":
            - columnheader "Amount"
            - columnheader "Unit"
            - columnheader "Item"
            - columnheader "Actions"
        - rowgroup:
          - row:
            - cell "4"
            - cell "tbsp"
            - cell "olive oil"
          - row:
            - cell "2"
            - cell
            - cell "red onions chopped"
          - row:
            - cell "2"
            - cell
            - cell "garlic cloves finely chopped"
          - row:
            - cell "2"
            - cell
            - cell "aubergines diced"
          - row:
            - cell "2"
            - cell
            - cell "red peppers seeded and diced"
          - row:
            - cell "1"
            - cell "tsp"
            - cell "smoked paprika"
          - row:
            - cell "2"
            - cell "tbsp"
            - cell "balsamic vinegar"
          - row:
            - cell "1"
            - cell "tsp"
            - cell "soy sauce"
          - row:
            - cell "500"
            - cell "ml"
            - cell "passata"
          - row:
            - cell "200"
            - cell "g"
            - cell "young goat’s cheese"
          - row:
            - cell "4"
            - cell
            - cell "courgettes (a mixture of green and yellow looks nice), thinly sliced"
          - row:
            - cell "400"
            - cell "ml"
            - cell "milk"
          - row:
            - cell "50"
            - cell "g"
            - cell "unsalted butter"
          - row:
            - cell "50"
            - cell "g"
            - cell "plain flour"
          - row:
            - cell "80"
            - cell "g"
            - cell "parmesan or vegetarian alternative, finely grated"
          - row:
            - cell
            - cell
            - cell
    `);

    // Steps prefilled with the 4 method steps.
    await expect(page.getByLabel("Steps")).not.toHaveValue("");

    await expect(page.getByAltText("Current photo")).toBeVisible();

    // 3. Save.
    await page.getByRole("button", { name: "Save recipe" }).click();
    await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { name: /ratatouille/i }),
    ).toBeVisible();
  });
});
