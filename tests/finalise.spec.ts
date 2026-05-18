import { expect, test } from "./fixtures";
import { login } from "./login";

async function createPasta(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Pasta al limone");
  await page.getByLabel("Ingredient 1 amount").fill("400");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("spaghetti");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
}

test("empty draft: Finalise button is not visible", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.goto("/kitchen");
  await expect(page.getByText("Draft 0", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finalise draft" }),
  ).toHaveCount(0);
});

test("finalise: confirm modal, redirects to /h/:flatId, items in stock", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In draft" }),
  ).toBeVisible();
  await page.goto("/kitchen");

  await page.getByRole("button", { name: "Finalise draft" }).click();
  await expect(page.getByText(/Finalise this draft\?/)).toBeVisible();
  await expect(page.getByText(/Pasta al limone \(serves 4\)/)).toBeVisible();

  await page
    .getByRole("button", { name: "Confirm finalise draft" })
    .click();
  await expect(page).toHaveURL(`/h/${flat.id}`);
  await expect(
    page.getByRole("link", { name: /Pasta al limone \(serves 4\)/ }),
  ).toBeVisible();
});

test("finalise while existing stock: handoff includes only latest draft batch", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  // Round 1: create + finalise.
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In draft" }),
  ).toBeVisible();
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // Round 2: a second recipe, finalise → handoff should only include this batch.
  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Risotto");
  await page.getByLabel("Ingredient 1 amount").fill("300");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("rice");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In draft" }),
  ).toBeVisible();
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();

  // Handoff only shows the just-finalised draft recipe.
  await expect(page).toHaveURL(`/h/${flat.id}`);
  await expect(
    page.getByRole("link", { name: /Pasta al limone \(serves 4\)/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Risotto \(serves 4\)/ }),
  ).toBeVisible();
});

test("public /r/:id renders recipe + JSON-LD, no auth required", async ({
  page,
  flat,
  browser,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  const url = new URL(page.url());
  const recipeId = url.pathname.split("/").pop()!;

  // Fresh context — no cookies.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/r/${recipeId}`);

  await expect(anonPage.getByRole("heading", { name: "Pasta al limone" })).toBeVisible();
  await expect(anonPage.getByText("400 g spaghetti")).toBeVisible();
  await expect(anonPage.getByText("Serves 4")).toBeVisible();

  const jsonLd = await anonPage.locator('script[type="application/ld+json"]').textContent();
  expect(jsonLd).toBeTruthy();
  const parsed = JSON.parse(jsonLd!);
  expect(parsed["@type"]).toBe("Recipe");
  expect(parsed.name).toBe("Pasta al limone");
  expect(parsed.recipeYield).toBe("4 servings");
  expect(parsed.recipeIngredient).toContain("400 g spaghetti");

  await anon.close();
});

test("public /r/:id?q=8 scales ingredients", async ({
  page,
  flat,
  browser,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  const recipeId = new URL(page.url()).pathname.split("/").pop()!;

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/r/${recipeId}?q=8`);

  await expect(anonPage.getByText("Serves 8")).toBeVisible();
  await expect(anonPage.getByText("800 g spaghetti")).toBeVisible();

  const jsonLd = JSON.parse(
    (await anonPage.locator('script[type="application/ld+json"]').textContent())!,
  );
  expect(jsonLd.recipeYield).toBe("8 servings");
  expect(jsonLd.recipeIngredient).toContain("800 g spaghetti");

  await anon.close();
});

test("public /h/:flatId renders stock + JSON-LD, no auth required", async ({
  page,
  flat,
  browser,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In draft" }),
  ).toBeVisible();
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/h/${flat.id}`);

  await expect(
    anonPage.getByRole("link", { name: /Pasta al limone \(serves 4\)/ }),
  ).toBeVisible();

  // JSON-LD aggregates all scaled ingredients from the shopping list.
  const jsonLd = JSON.parse(
    (await anonPage.locator('script[type="application/ld+json"]').textContent())!,
  );
  expect(jsonLd["@type"]).toBe("Recipe");
  expect(jsonLd.recipeIngredient).toContain("400 g spaghetti");

  await anon.close();
});

test("public /h/:flatId 404 for invalid flat id", async ({ browser }) => {
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const res = await anonPage.goto("/h/not-a-uuid");
  expect(res?.status()).toBe(404);
  await anon.close();
});
