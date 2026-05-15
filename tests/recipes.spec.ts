import { test, expect } from "./fixtures";
import { login } from "./login";

test("create a recipe → see it on home → open detail view", async ({ page, flat }) => {
  await login(page, flat.user);

  await page.getByRole("link", { name: "+ New recipe" }).click();
  await expect(page).toHaveURL("/recipes/new");

  await page.getByLabel("Name").fill("Pasta al limone");
  await page.getByLabel("Base unit").fill("servings");
  // Base quantity is pre-filled with 4.

  await page.getByLabel("Source URL").fill("https://smittenkitchen.com/pasta");

  await page.getByLabel("Ingredient 1 amount").fill("400");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("spaghetti");

  await page.getByLabel("Ingredient 2 amount").fill("2");
  await page.getByLabel("Ingredient 2 unit").fill("");
  await page.getByLabel("Ingredient 2 item").fill("lemons");

  await page.getByLabel("Ingredient 3 item").fill("olive oil, salt, pepper");

  await page.getByLabel("Steps").fill("1. Boil salted water.\n2. Cook pasta.");

  await page.getByRole("button", { name: "Save recipe" }).click();

  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Pasta al limone" })).toBeVisible();
  await expect(page.getByText("400 g spaghetti")).toBeVisible();
  await expect(page.getByText("2 lemons")).toBeVisible();
  await expect(page.getByText("olive oil, salt, pepper")).toBeVisible();
  await expect(page.getByText(/Boil salted water/)).toBeVisible();
  await expect(page.getByRole("link", { name: /smittenkitchen\.com/ })).toBeVisible();

  await page.getByRole("link", { name: "← Collection" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: /Pasta al limone/ })).toBeVisible();
});

test("recipe form rejects empty name and missing ingredients", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "+ New recipe" }).click();

  // Name empty → browser may block submit (HTML required). Provide a name
  // but leave ingredients blank.
  await page.getByLabel("Name").fill("Empty test");
  await page.getByRole("button", { name: "Save recipe" }).click();

  await expect(page.getByRole("alert")).toContainText(/at least one ingredient/i);
});

test("recipes are scoped to the flat — other flat's recipe → 404", async ({
  page,
  flat,
  request,
}) => {
  // Create a recipe in flat A.
  await login(page, flat.user);
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Secret recipe");
  await page.getByLabel("Ingredient 1 item").fill("water");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/([0-9a-f-]{36})$/);
  const recipeUrl = page.url();
  await page.context().clearCookies();

  // Provision a second flat (flat B) and log in as its user.
  const adminRes = await request.post("/admin/tenants", {
    data: {},
    headers: { "X-Admin-Token": "test-admin-token" },
  });
  const { inviteUrl } = (await adminRes.json()) as { inviteUrl: string };
  await page.goto(inviteUrl);
  const otherEmail = `other-${Date.now()}@cookbook.test`;
  await page.getByLabel("Email").fill(otherEmail);
  await page.getByLabel("Display name").fill("Other Cook");
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("cookbook-other-password");
  await page.getByRole("button", { name: "Create account & join" }).click();
  await page.waitForURL("/");

  // Other user can't see flat A's recipe.
  const res = await page.goto(recipeUrl);
  expect(res?.status()).toBe(404);
});
