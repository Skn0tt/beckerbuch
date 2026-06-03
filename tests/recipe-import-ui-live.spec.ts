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

    const ingredientsBlock = page
      .getByRole("heading", { name: "Ingredients" })
      .locator("..");

    await expect.soft(ingredientsBlock).toMatchAriaSnapshot(`
      - heading "Ingredients" [level=5]
      - table "Ingredients":
        - rowgroup:
          - row "Amount Unit Item Actions":
            - columnheader "Amount"
            - columnheader "Unit"
            - columnheader "Item"
            - columnheader "Actions"
        - rowgroup:
          - row "Ingredient 1":
            - cell "4":
              - textbox "Amount":
                - text: "4"
            - cell "tbsp":
              - textbox "Unit":
                - text: tbsp
            - cell "olive oil":
              - textbox "Item":
                - text: olive oil
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 2":
            - cell "2":
              - textbox "Amount":
                - text: "2"
            - cell:
              - textbox "Unit"
            - cell "red onions chopped":
              - textbox "Item":
                - text: red onions chopped
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 3":
            - cell "2":
              - textbox "Amount":
                - text: "2"
            - cell:
              - textbox "Unit"
            - cell "garlic cloves finely chopped":
              - textbox "Item":
                - text: garlic cloves finely chopped
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 4":
            - cell "2":
              - textbox "Amount":
                - text: "2"
            - cell:
              - textbox "Unit"
            - cell "aubergines diced":
              - textbox "Item":
                - text: aubergines diced
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 5":
            - cell "2":
              - textbox "Amount":
                - text: "2"
            - cell:
              - textbox "Unit"
            - cell "red peppers seeded and diced":
              - textbox "Item":
                - text: red peppers seeded and diced
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 6":
            - cell "1":
              - textbox "Amount":
                - text: "1"
            - cell "tsp":
              - textbox "Unit":
                - text: tsp
            - cell "smoked paprika":
              - textbox "Item":
                - text: smoked paprika
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 7":
            - cell "2":
              - textbox "Amount":
                - text: "2"
            - cell "tbsp":
              - textbox "Unit":
                - text: tbsp
            - cell "balsamic vinegar":
              - textbox "Item":
                - text: balsamic vinegar
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 8":
            - cell "1":
              - textbox "Amount":
                - text: "1"
            - cell "tsp":
              - textbox "Unit":
                - text: tsp
            - cell "soy sauce":
              - textbox "Item":
                - text: soy sauce
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 9":
            - cell "500":
              - textbox "Amount":
                - text: "500"
            - cell "ml":
              - textbox "Unit":
                - text: ml
            - cell "passata":
              - textbox "Item":
                - text: passata
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 10":
            - cell "200":
              - textbox "Amount":
                - text: "200"
            - cell "g":
              - textbox "Unit":
                - text: g
            - cell "young goat’s cheese":
              - textbox "Item":
                - text: young goat’s cheese
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 11":
            - cell "4":
              - textbox "Amount":
                - text: "4"
            - cell:
              - textbox "Unit"
            - cell "courgettes (a mixture of green and yellow looks nice), thinly sliced":
              - textbox "Item":
                - text: courgettes (a mixture of green and yellow looks nice), thinly sliced
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 12":
            - cell "400":
              - textbox "Amount":
                - text: "400"
            - cell "ml":
              - textbox "Unit":
                - text: ml
            - cell "milk":
              - textbox "Item":
                - text: milk
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 13":
            - cell "50":
              - textbox "Amount":
                - text: "50"
            - cell "g":
              - textbox "Unit":
                - text: g
            - cell "unsalted butter":
              - textbox "Item":
                - text: unsalted butter
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 14":
            - cell "50":
              - textbox "Amount":
                - text: "50"
            - cell "g":
              - textbox "Unit":
                - text: g
            - cell "plain flour":
              - textbox "Item":
                - text: plain flour
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 15":
            - cell "80":
              - textbox "Amount":
                - text: "80"
            - cell "g":
              - textbox "Unit":
                - text: g
            - cell "parmesan or vegetarian alternative, finely grated":
              - textbox "Item":
                - text: parmesan or vegetarian alternative, finely grated
            - cell "Remove":
              - button "Remove": ✕
          - row "Ingredient 16":
            - cell:
              - textbox "Amount"
            - cell:
              - textbox "Unit"
            - cell:
              - textbox "Item"
            - cell "Remove":
              - button "Remove": ✕
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
