import { expect, test } from "./fixtures";
import { login } from "./login";
import type { Page } from "@playwright/test";
import { openAiDedupHandler } from "./mock-handlers";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

test.beforeEach(async ({ mocks }) => {
  await mocks.route(OPENAI_CHAT_URL, openAiDedupHandler());
});

/**
 * Create a recipe with a single ingredient via the new-recipe form,
 * add it to the draft, and return to /kitchen. Mirrors the pattern in
 * tests/finalise.spec.ts.
 */
async function createRecipeWithIngredient(
  page: Page,
  name: string,
  amount: string,
  unit: string,
  item: string,
) {
  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Ingredient 1 amount").fill(amount);
  await page.getByLabel("Ingredient 1 unit").fill(unit);
  await page.getByLabel("Ingredient 1 item").fill(item);
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In draft" }),
  ).toBeVisible();
}

async function finalise(page: Page, flatId: string) {
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flatId}`);
}

async function jsonLd(page: Page): Promise<{ recipeIngredient: string[] }> {
  const text = await page
    .locator('script[type="application/ld+json"]')
    .textContent();
  if (!text) throw new Error("no JSON-LD");
  return JSON.parse(text);
}

test("merges trivial-variant ingredients ('300 g tomato' + '300 g tomatos' → '600 g tomato')", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createRecipeWithIngredient(page, "Pasta al pomodoro", "300", "g", "tomato");
  await createRecipeWithIngredient(page, "Tomato soup", "300", "g", "tomatos");
  await finalise(page, flat.id);

  // Combined list shows one merged row.
  const merged = page
    .getByTestId("combined-row")
    .filter({ has: page.getByText("600 g tomato", { exact: true }) });
  await expect(merged).toHaveCount(1);
  await expect(merged).toHaveAttribute("data-merged", "true");
  await expect(merged.getByText(/Pasta al pomodoro/)).toBeVisible();
  await expect(merged.getByText(/Tomato soup/)).toBeVisible();

  // JSON-LD has exactly one tomato entry, summed.
  const ld = await jsonLd(page);
  expect(ld.recipeIngredient.filter((s) => s.includes("tomato"))).toEqual([
    "600 g tomato",
  ]);
});

test("split a merged group → JSON-LD expands back, survives reload, can un-split", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createRecipeWithIngredient(page, "Pasta al pomodoro", "300", "g", "tomato");
  await createRecipeWithIngredient(page, "Tomato soup", "300", "g", "tomatos");
  await finalise(page, flat.id);

  // Split it.
  await page.getByRole("button", { name: "Split tomato" }).click();
  await expect(
    page.getByRole("button", { name: "Undo split for tomato" }),
  ).toBeVisible();

  // JSON-LD now has two tomato entries (the original source lines).
  let ld = await jsonLd(page);
  expect(ld.recipeIngredient.filter((s) => s.includes("tomato")).sort()).toEqual(
    ["300 g tomato", "300 g tomatos"],
  );

  // Reload — split persists.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Undo split for tomato" }),
  ).toBeVisible();
  ld = await jsonLd(page);
  expect(ld.recipeIngredient.filter((s) => s.includes("tomato")).sort()).toEqual(
    ["300 g tomato", "300 g tomatos"],
  );

  // Un-split.
  await page.getByRole("button", { name: "Undo split for tomato" }).click();
  await expect(page.getByText("600 g tomato", { exact: true })).toBeVisible();
  ld = await jsonLd(page);
  expect(ld.recipeIngredient.filter((s) => s.includes("tomato"))).toEqual([
    "600 g tomato",
  ]);
});

test("incompatible units stay as separate rows ('200 g flour' + '2 cups flour')", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createRecipeWithIngredient(page, "Bread", "200", "g", "flour");
  await createRecipeWithIngredient(page, "Pancakes", "2", "cups", "flour");
  await finalise(page, flat.id);

  // The fake backend pairs both ids (same item), but the post-processor
  // splits them by unit family. Result: two separate single-source rows.
  const rows = page.getByTestId("combined-row");
  await expect(rows.filter({ hasText: /200 g flour/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: /2 cups flour/ })).toHaveCount(1);

  const ld = await jsonLd(page);
  expect(ld.recipeIngredient).toContain("200 g flour");
  expect(ld.recipeIngredient).toContain("2 cups flour");
});

test("public — anonymous visitor sees combined list and can split", async ({
  page,
  flat,
  browser,
}) => {
  await login(page, flat.user);
  await createRecipeWithIngredient(page, "Pasta al pomodoro", "300", "g", "tomato");
  await createRecipeWithIngredient(page, "Tomato soup", "300", "g", "tomatos");
  await finalise(page, flat.id);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/h/${flat.id}`);
  await expect(anonPage.getByText("600 g tomato", { exact: true })).toBeVisible();
  await anonPage.getByRole("button", { name: "Split tomato" }).click();
  await expect(
    anonPage.getByRole("button", { name: "Undo split for tomato" }),
  ).toBeVisible();
  await anon.close();
});

test("LLM failure during finalise: redirect still happens, list renders as singletons", async ({
  page,
  flat,
  mocks,
}) => {
  // Force the LLM call to fail. The OpenAI SDK throws on 500, dedup()
  // catches and returns the all-singletons fallback. Same code path
  // the 20s AbortController triggers when the real API is too slow.
  //
  // In dev the request goes through Netlify's emulated AI Gateway
  // (NOT api.openai.com), so we match the gateway URL directly.
  await mocks.route(
    /\.netlify\/ai\/chat\/completions/,
    openAiDedupHandler({ fail: true }),
  );

  await login(page, flat.user);
  await createRecipeWithIngredient(page, "Pasta al pomodoro", "300", "g", "tomato");
  await createRecipeWithIngredient(page, "Tomato soup", "300", "g", "tomatos");

  // Finalise must still redirect — no 504, no hang.
  await finalise(page, flat.id);

  // Both ingredients render as separate rows (singletons), no merge.
  const combined = page.getByTestId("combined-list");
  await expect(combined.getByText("300 g tomato", { exact: true })).toBeVisible();
  await expect(combined.getByText("300 g tomatos", { exact: true })).toBeVisible();
});

test("stale snapshot: editing a recipe after finalise shows Regenerate; clicking it re-merges", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createRecipeWithIngredient(page, "Pasta al pomodoro", "300", "g", "tomato");
  await createRecipeWithIngredient(page, "Tomato soup", "300", "g", "tomatos");
  await finalise(page, flat.id);

  // Sanity: merged at this point.
  await expect(page.getByText("600 g tomato", { exact: true })).toBeVisible();

  // Edit one of the recipes — bump the tomato amount. We do this by
  // visiting the recipe edit page directly.
  await page.goto("/");
  await page.getByRole("link", { name: /Pasta al pomodoro/ }).first().click();
  await page.getByRole("link", { name: /Edit recipe/ }).click();
  await page.getByLabel("Ingredient 1 amount").fill("500");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);

  await page.goto(`/h/${flat.id}`);
  // Snapshot is now stale → Regenerate button appears, list is rendered
  // unmerged.
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
  const combined = page.getByTestId("combined-list");
  await expect(combined.getByText("500 g tomato", { exact: true })).toBeVisible();
  await expect(combined.getByText("300 g tomatos", { exact: true })).toBeVisible();

  // Regenerate → fresh snapshot, things merge again (500 + 300 = 800).
  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(combined.getByText("800 g tomato", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);
});
