import { expect, test } from "./fixtures";
import { login } from "./login";
import { openAiDedupHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route(
    "https://api.openai.com/v1/chat/completions",
    openAiDedupHandler(),
  );
});

async function createRecipe(
  page: import("@playwright/test").Page,
  name: string,
  ingredients: { amount: string; unit: string; item: string }[],
) {
  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill(name);
  for (let i = 0; i < ingredients.length; i++) {
    if (i > 0) {
      await page.getByRole("button", { name: "+ Add ingredient" }).click();
    }
    const idx = i + 1;
    await page.getByLabel(`Ingredient ${idx} amount`).fill(ingredients[i].amount);
    await page.getByLabel(`Ingredient ${idx} unit`).fill(ingredients[i].unit);
    await page.getByLabel(`Ingredient ${idx} item`).fill(ingredients[i].item);
  }
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
}

test("ingredients lane: empty by default", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.goto("/kitchen?lane=ingredients");
  await expect(
    page.getByText("No ingredients planned"),
  ).toBeVisible();
});

test("ingredients lane: merges shared ingredients across in-stock recipes and lists their recipes", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  // Two recipes that share "tomato" in g.
  await createRecipe(page, "Pasta al pomodoro", [
    { amount: "400", unit: "g", item: "spaghetti" },
    { amount: "300", unit: "g", item: "tomato" },
  ]);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  await createRecipe(page, "Tomato salad", [
    { amount: "500", unit: "g", item: "tomato" },
    { amount: "1", unit: "bunch", item: "basil" },
  ]);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  // Finalise → both into stock.
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // Ingredients view aggregates across both recipes.
  await page.goto("/kitchen?lane=ingredients");
  const list = page.getByTestId("planned-ingredients");
  await expect(list).toBeVisible();

  // tomato: 300g + 500g = 800g, contributed by both recipes.
  const tomatoCard = list.locator("text=800 g tomato").locator("..");
  await expect(tomatoCard).toContainText("Pasta al pomodoro");
  await expect(tomatoCard).toContainText("Tomato salad");

  // Recipe-specific lines still show.
  await expect(list.getByText("400 g spaghetti")).toBeVisible();
  await expect(list.getByText("1 bunch basil")).toBeVisible();
});

test("ingredients lane: scales by target quantity", async ({ page, flat }) => {
  await login(page, flat.user);
  await createRecipe(page, "Pasta", [
    { amount: "100", unit: "g", item: "spaghetti" },
  ]);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  // Base is 4 servings → bump to 8 → ingredient should double.
  await page.goto("/kitchen");
  await page
    .getByRole("button", { name: "Increase Pasta portions" })
    .click();
  await page
    .getByRole("button", { name: "Increase Pasta portions" })
    .click();
  await page
    .getByRole("button", { name: "Increase Pasta portions" })
    .click();
  await page
    .getByRole("button", { name: "Increase Pasta portions" })
    .click();

  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  await page.goto("/kitchen?lane=ingredients");
  await expect(page.getByText("200 g spaghetti")).toBeVisible();
});
