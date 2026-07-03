import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { login } from "./login";
import { openAiEmbeddingHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route("https://api.openai.com/v1/embeddings", openAiEmbeddingHandler());
});

async function createRecipeWithIngredient(
  page: Page,
  name: string,
  amount: string,
  unit: string,
  item: string,
): Promise<string> {
  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Amount").fill(amount);
  await page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Unit").fill(unit);
  await page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Item").fill(item);
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  const url = page.url();
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
  return url;
}

test("ingredients tab: empty when nothing in stock", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.goto("/kitchen?lane=ingredients");

  // The visible label text for the Ingredients segment should be on screen.
  await expect(page.getByText("Ingredients", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No planned ingredients", { exact: false }),
  ).toBeVisible();
});

test("ingredients tab: shows ingredients from in-stock recipes with recipe name", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  // Create a recipe with one ingredient.
  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Pasta al limone");
  await page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Amount").fill("400");
  await page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Unit").fill("g");
  await page.getByRole("row", { name: "Ingredient 1", exact: true }).getByLabel("Item").fill("spaghetti");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);

  // Add to draft, then finalise to move it to in-stock.
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  // Wait for the finalise redirect to complete before navigating away.
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // Navigate to the ingredients tab.
  await page.goto("/kitchen?lane=ingredients");

  await expect(page.getByRole("heading", { name: "Planned ingredients" })).toBeVisible();
  // The ingredient from the in-stock recipe should be listed.
  await expect(page.getByText("400 g spaghetti")).toBeVisible();
  // The recipe name should appear as context.
  await expect(page.getByText("Pasta al limone")).toBeVisible();
});

test("ingredients tab: merges duplicate ingredients into one combined row", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  await createRecipeWithIngredient(page, "Pasta al pomodoro", "300", "g", "tomato");
  await createRecipeWithIngredient(page, "Tomato soup", "300", "g", "tomatos");

  // Finalise the draft to move both recipes to in-stock.
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  await page.goto("/kitchen?lane=ingredients");

  // The two tomato ingredients should be combined into a single summed row.
  const merged = page
    .getByTestId("combined-row")
    .filter({ has: page.getByText("600 g tomato", { exact: true }) });
  await expect(merged).toHaveCount(1);
  await expect(merged).toHaveAttribute("data-merged", "true");
  await expect(merged.getByText(/Pasta al pomodoro/)).toBeVisible();
  await expect(merged.getByText(/Tomato soup/)).toBeVisible();
});

test("ingredients tab: re-merges over what's still to cook after a recipe is cooked", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  await createRecipeWithIngredient(page, "Pasta al pomodoro", "300", "g", "tomato");
  await createRecipeWithIngredient(page, "Tomato soup", "300", "g", "tomatos");
  const bruschettaUrl = await createRecipeWithIngredient(
    page,
    "Bruschetta",
    "200",
    "g",
    "tomato",
  );

  // Finalise the draft to move all three recipes to in-stock.
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // All three tomato ingredients merge into 800 g.
  await page.goto("/kitchen?lane=ingredients");
  await expect(
    page.getByTestId("combined-row").filter({
      has: page.getByText("800 g tomato", { exact: true }),
    }),
  ).toHaveCount(1);

  // Cook Bruschetta — it leaves the in-stock set.
  await page.goto(bruschettaUrl);
  await page.getByRole("button", { name: "Mark as cooked" }).click();
  await page
    .getByRole("button", { name: "Confirm mark Bruschetta as cooked" })
    .click();
  // After cooking, the recipe leaves In stock and the add-to-draft affordance
  // returns — a reliable signal the action completed.
  await expect(page.getByRole("button", { name: "+ Add to draft" })).toBeVisible();

  // The planned-ingredients view re-merges over the two remaining recipes.
  await page.goto("/kitchen?lane=ingredients");
  const merged = page
    .getByTestId("combined-row")
    .filter({ has: page.getByText("600 g tomato", { exact: true }) });
  await expect(merged).toHaveCount(1);
  await expect(merged).toHaveAttribute("data-merged", "true");
  await expect(merged.getByText(/Pasta al pomodoro/)).toBeVisible();
  await expect(merged.getByText(/Tomato soup/)).toBeVisible();
  await expect(merged.getByText(/Bruschetta/)).toHaveCount(0);
});

test("ingredients tab: shows recipes from every in-stock finalise batch, not just the latest", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  // Batch A: finalise a first recipe. It stays in stock (uncooked).
  await createRecipeWithIngredient(page, "Pasta al limone", "400", "g", "spaghetti");
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // Batch B: finalise a second recipe in a new draft while batch A is still
  // uncooked. This creates two coexisting finalise batches — the case that
  // used to make the ingredients tab go empty (it filtered to the latest
  // finalise batch via MAX(finalised_at), hiding batch A entirely).
  await createRecipeWithIngredient(page, "Risotto", "200", "g", "rice");
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  await page.goto("/kitchen?lane=ingredients");

  // Both batches are in stock, so both ingredients must be listed — the newer
  // batch B must not hide the older-but-still-uncooked batch A.
  await expect(page.getByText("400 g spaghetti")).toBeVisible();
  await expect(page.getByText("Pasta al limone")).toBeVisible();
  await expect(page.getByText("200 g rice")).toBeVisible();
  await expect(page.getByText("Risotto")).toBeVisible();
});
