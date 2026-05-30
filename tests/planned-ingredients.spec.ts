import { expect, test } from "./fixtures";
import { login } from "./login";
import { openAiDedupHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route("https://api.openai.com/v1/chat/completions", openAiDedupHandler());
});

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
  await page.getByLabel("Ingredient 1 amount").fill("400");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("spaghetti");
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
