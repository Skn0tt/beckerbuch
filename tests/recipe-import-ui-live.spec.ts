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
    await expect(page.getByLabel("Ingredient 1 item")).not.toHaveValue("");

    const ingredientsBlock = page
      .getByRole("heading", { name: "Ingredients" })
      .locator("..");

    await expect.soft(ingredientsBlock).toMatchAriaSnapshot(`
      - heading "Ingredients" [level=5]
      - textbox "Ingredient 1 amount":
        - /placeholder: amt
        - text: "4"
      - textbox "Ingredient 1 unit":
        - /placeholder: unit
        - text: tbsp
      - textbox "Ingredient 1 item":
        - /placeholder: item
        - text: olive oil
      - button "Remove ingredient 1": ✕
      - textbox "Ingredient 2 amount":
        - /placeholder: amt
        - text: "2"
      - textbox "Ingredient 2 unit":
        - /placeholder: unit
      - textbox "Ingredient 2 item":
        - /placeholder: item
        - text: red onions chopped
      - button "Remove ingredient 2": ✕
      - textbox "Ingredient 3 amount":
        - /placeholder: amt
        - text: "2"
      - textbox "Ingredient 3 unit":
        - /placeholder: unit
      - textbox "Ingredient 3 item":
        - /placeholder: item
        - text: garlic cloves finely chopped
      - button "Remove ingredient 3": ✕
      - textbox "Ingredient 4 amount":
        - /placeholder: amt
        - text: "2"
      - textbox "Ingredient 4 unit":
        - /placeholder: unit
      - textbox "Ingredient 4 item":
        - /placeholder: item
        - text: aubergines diced
      - button "Remove ingredient 4": ✕
      - textbox "Ingredient 5 amount":
        - /placeholder: amt
        - text: "2"
      - textbox "Ingredient 5 unit":
        - /placeholder: unit
      - textbox "Ingredient 5 item":
        - /placeholder: item
        - text: red peppers seeded and diced
      - button "Remove ingredient 5": ✕
      - textbox "Ingredient 6 amount":
        - /placeholder: amt
        - text: "1"
      - textbox "Ingredient 6 unit":
        - /placeholder: unit
        - text: tsp
      - textbox "Ingredient 6 item":
        - /placeholder: item
        - text: smoked paprika
      - button "Remove ingredient 6": ✕
      - textbox "Ingredient 7 amount":
        - /placeholder: amt
        - text: "2"
      - textbox "Ingredient 7 unit":
        - /placeholder: unit
        - text: tbsp
      - textbox "Ingredient 7 item":
        - /placeholder: item
        - text: balsamic vinegar
      - button "Remove ingredient 7": ✕
      - textbox "Ingredient 8 amount":
        - /placeholder: amt
        - text: "1"
      - textbox "Ingredient 8 unit":
        - /placeholder: unit
        - text: tsp
      - textbox "Ingredient 8 item":
        - /placeholder: item
        - text: soy sauce
      - button "Remove ingredient 8": ✕
      - textbox "Ingredient 9 amount":
        - /placeholder: amt
        - text: "500"
      - textbox "Ingredient 9 unit":
        - /placeholder: unit
        - text: ml
      - textbox "Ingredient 9 item":
        - /placeholder: item
        - text: passata
      - button "Remove ingredient 9": ✕
      - textbox "Ingredient 10 amount":
        - /placeholder: amt
        - text: "200"
      - textbox "Ingredient 10 unit":
        - /placeholder: unit
        - text: g
      - textbox "Ingredient 10 item":
        - /placeholder: item
        - text: young goat’s cheese
      - button "Remove ingredient 10": ✕
      - textbox "Ingredient 11 amount":
        - /placeholder: amt
        - text: "4"
      - textbox "Ingredient 11 unit":
        - /placeholder: unit
      - textbox "Ingredient 11 item":
        - /placeholder: item
        - text: courgettes (a mixture of green and yellow looks nice), thinly sliced
      - button "Remove ingredient 11": ✕
      - textbox "Ingredient 12 amount":
        - /placeholder: amt
        - text: "400"
      - textbox "Ingredient 12 unit":
        - /placeholder: unit
        - text: ml
      - textbox "Ingredient 12 item":
        - /placeholder: item
        - text: milk
      - button "Remove ingredient 12": ✕
      - textbox "Ingredient 13 amount":
        - /placeholder: amt
        - text: "50"
      - textbox "Ingredient 13 unit":
        - /placeholder: unit
        - text: g
      - textbox "Ingredient 13 item":
        - /placeholder: item
        - text: unsalted butter
      - button "Remove ingredient 13": ✕
      - textbox "Ingredient 14 amount":
        - /placeholder: amt
        - text: "50"
      - textbox "Ingredient 14 unit":
        - /placeholder: unit
        - text: g
      - textbox "Ingredient 14 item":
        - /placeholder: item
        - text: plain flour
      - button "Remove ingredient 14": ✕
      - textbox "Ingredient 15 amount":
        - /placeholder: amt
        - text: "80"
      - textbox "Ingredient 15 unit":
        - /placeholder: unit
        - text: g
      - textbox "Ingredient 15 item":
        - /placeholder: item
        - text: parmesan or vegetarian alternative, finely grated
      - button "Remove ingredient 15": ✕
      - textbox "Ingredient 16 amount":
        - /placeholder: amt
      - textbox "Ingredient 16 unit":
        - /placeholder: unit
      - textbox "Ingredient 16 item":
        - /placeholder: item
      - button "Remove ingredient 16": ✕
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
