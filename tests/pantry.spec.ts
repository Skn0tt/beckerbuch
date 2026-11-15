import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { login } from "./login";
import { geminiEmbeddingHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route(
    "https://generativelanguage.googleapis.com/**",
    geminiEmbeddingHandler(),
  );
});

async function jsonLd(page: Page): Promise<{ recipeIngredient: string[] }> {
  const text = await page
    .locator('script[type="application/ld+json"]')
    .textContent();
  if (!text) throw new Error("no JSON-LD");
  return JSON.parse(text);
}

test("pantry list adds a name, rejects a duplicate, and removes it", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await page.goto("/flat/settings");

  await expect(page.getByRole("heading", { name: "Pantry" })).toBeVisible();
  await expect(page.getByText("Nothing yet.")).toBeVisible();

  await page.getByRole("textbox", { name: "Pantry item" }).fill("Salz");
  await page.getByRole("button", { name: "Add to pantry" }).click();
  const list = page.getByRole("list", { name: "Pantry" });
  await expect(list.getByText("Salz", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing yet.")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Pantry item" })).toHaveValue(
    "",
  );

  await page.getByRole("textbox", { name: "Pantry item" }).fill("  salz  ");
  await page.getByRole("button", { name: "Add to pantry" }).click();
  await expect(page.getByText("Already on the pantry list.")).toBeVisible();
  await expect(list.getByText("Salz", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove Salz" }).click();
  await expect(page.getByText("Nothing yet.")).toBeVisible();
});

test("pantry names stay off the shopping list and on the recipe", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Risi e Bisi");
  const first = page.getByRole("row", { name: "Ingredient 1", exact: true });
  await first.getByLabel("Amount").fill("200");
  await first.getByLabel("Unit").fill("g");
  await first.getByLabel("Item").fill("flour");
  const second = page.getByRole("row", { name: "Ingredient 2", exact: true });
  await second.getByLabel("Amount").fill("1");
  await second.getByLabel("Unit").fill("tsp");
  await second.getByLabel("Item").fill("salt");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  const recipeUrl = page.url();

  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  const combined = page.getByTestId("combined-list");
  await expect(combined.getByText("200 g flour")).toBeVisible();
  await expect(combined.getByText("1 tsp salt")).toBeVisible();

  await page.goto("/flat/settings");
  await page.getByRole("textbox", { name: "Pantry item" }).fill("Salt");
  await page.getByRole("button", { name: "Add to pantry" }).click();
  await expect(
    page.getByRole("list", { name: "Pantry" }).getByText("Salt"),
  ).toBeVisible();

  await page.goto(`/h/${flat.id}`);
  await expect(combined.getByText("200 g flour")).toBeVisible();
  await expect(combined.getByText("1 tsp salt")).toHaveCount(0);
  const hidden = await jsonLd(page);
  expect(hidden.recipeIngredient).toContain("200 g flour");
  expect(hidden.recipeIngredient.some((line) => line.includes("salt"))).toBe(
    false,
  );
  // The handoff still shows the recipe's own lines. The shop list is what changed.
  await expect(page.getByText("1 tsp salt")).toBeVisible();

  await page.goto(recipeUrl);
  await expect(page.getByText("200 g flour")).toBeVisible();
  await expect(page.getByText("1 tsp salt")).toBeVisible();

  await page.goto("/kitchen?lane=ingredients");
  await expect(
    page.getByRole("heading", { name: "Planned ingredients" }),
  ).toBeVisible();
  await expect(page.getByText("1 tsp salt")).toBeVisible();
  await expect(page.getByText("200 g flour")).toBeVisible();

  await page.goto("/flat/settings");
  await page.getByRole("button", { name: "Remove Salt" }).click();
  await expect(page.getByText("Nothing yet.")).toBeVisible();
  await page.goto(`/h/${flat.id}`);
  await expect(
    page.getByTestId("combined-list").getByText("1 tsp salt"),
  ).toBeVisible();
  const restored = await jsonLd(page);
  expect(restored.recipeIngredient.some((line) => line.includes("salt"))).toBe(
    true,
  );
});
