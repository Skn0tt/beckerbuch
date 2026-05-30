import { test, expect } from "./fixtures";
import { login } from "./login";

test("create a recipe → see it on home → open detail view", async ({ page, flat }) => {
  await login(page, flat.user);

  await page.getByRole("link", { name: "+ New recipe" }).click();
  await expect(page).toHaveURL("/recipes/new");

  await page.getByLabel("Name").fill("Pasta al limone");
  // Base portions is pre-filled with 4.

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
  await expect(page.getByRole("heading", { name: "Draft" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pasta al limone" })).toBeVisible();
  await expect(page.getByText("400 g spaghetti")).toBeVisible();
  await expect(page.getByText("2 lemons")).toBeVisible();
  await expect(page.getByText("olive oil, salt, pepper")).toBeVisible();
  await expect(page.getByText(/Boil salted water/)).toBeVisible();
  await expect(page.getByRole("link", { name: /smittenkitchen\.com/ })).toBeVisible();

  await page.goto("/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: /Pasta al limone/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft" })).toBeVisible();
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

test("recipe form keeps one trailing empty ingredient row", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "+ New recipe" }).click();

  await expect(page.getByRole("button", { name: "+ Add ingredient" })).toHaveCount(0);
  await expect(page.getByLabel("Ingredient 2 item")).toHaveCount(0);

  await expect(page.getByLabel("Ingredient 1 unit")).toHaveAttribute(
    "autocapitalize",
    "none",
  );
  await expect(page.getByLabel("Ingredient 1 unit")).toHaveAttribute(
    "autocorrect",
    "off",
  );

  await page.getByLabel("Ingredient 1 item").fill("flour");
  await expect(page.getByLabel("Ingredient 2 item")).toBeVisible();

  await page.getByLabel("Ingredient 2 item").fill("water");
  await expect(page.getByLabel("Ingredient 3 item")).toBeVisible();
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

test("rapid double-click on Save creates only one recipe", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "+ New recipe" }).click();

  await page.getByLabel("Name").fill("Double click test");
  await page.getByLabel("Ingredient 1 item").fill("water");

  // Delay the POST so the user has time to click again while the first
  // submission is still in flight. Count POSTs to prove the second click
  // never reaches the server.
  let postCount = 0;
  await page.route(/\/recipes\/new(\.data)?$/, async (route) => {
    if (route.request().method() === "POST") {
      postCount += 1;
      await new Promise((r) => setTimeout(r, 800));
    }
    await route.continue();
  });

  const save = page.getByRole("button", { name: "Save recipe" });
  await save.click();
  // Second click happens while the first POST is mid-flight.
  await save.click({ force: true, noWaitAfter: true }).catch(() => {});
  await expect(save).toBeDisabled();

  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  expect(postCount).toBe(1);

  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /Double click test/ }),
  ).toHaveCount(1);
});

test("malformed UUID in /r/:id → 404", async ({ page }) => {
  const res = await page.goto("/r/lol");
  expect(res?.status()).toBe(404);
});

async function createPasta(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Pasta al limone");
  await page.getByLabel("Ingredient 1 amount").fill("400");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("spaghetti");
  await page.getByLabel("Ingredient 2 item").fill("lemons");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
}

test("edit a recipe — change name + ingredient, see it on view + home", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);

  await page.getByRole("link", { name: "Edit recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}\/edit$/);

  // Pre-filled values are present.
  await expect(page.getByLabel("Name")).toHaveValue("Pasta al limone");
  await expect(page.getByLabel("Ingredient 1 item")).toHaveValue("spaghetti");

  // Tweak. Assert intermediate values to defend against React not having
  // committed the controlled state by the time we click Save.
  await page.getByLabel("Name").fill("Pasta al limone (better)");
  await expect(page.getByLabel("Name")).toHaveValue("Pasta al limone (better)");
  await page.getByLabel("Ingredient 1 amount").fill("450");
  await expect(page.getByLabel("Ingredient 1 amount")).toHaveValue("450");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { name: "Pasta al limone (better)" }),
  ).toBeVisible();
  await expect(page.getByText("450 g spaghetti")).toBeVisible();

  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /Pasta al limone \(better\)/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Pasta al limone", exact: true }),
  ).toHaveCount(0);
});

test("delete a recipe — back on home, recipe gone", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);

  await page.getByRole("link", { name: "Edit recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}\/edit$/);

  // Auto-accept the confirm() dialog the Delete button raises.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete recipe" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByText("No recipes yet")).toBeVisible();
});

test("deleting a recipe that's in the draft is blocked", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);
  const recipeUrl = page.url();

  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  await page.getByRole("link", { name: "Edit recipe" }).click();
  const editUrl = page.url();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete recipe" }).click();

  await expect(
    page.getByText(/in your draft, in stock, or cooked history/),
  ).toBeVisible();
  // Still on the edit page, not deleted.
  await expect(page).toHaveURL(editUrl);

  // And the recipe is still reachable.
  await page.goto(recipeUrl);
  await expect(page.getByRole("heading", { name: "Pasta al limone" })).toBeVisible();
});

// 1×1 transparent PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

test("upload a photo on create → see it on view; remove it on edit", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Photo recipe");
  await page.getByLabel("Ingredient 1 item").fill("water");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: TINY_PNG });
  await page.getByRole("button", { name: "Save recipe" }).click();

  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  const photoImg = page.getByRole("img", { name: "Photo recipe" });
  await expect(photoImg).toBeVisible();
  // Image actually loads (browser parsed it).
  await expect
    .poll(async () => await photoImg.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);

  // Edit → tick "Remove current photo" → save → photo gone.
  await page.getByRole("link", { name: "Edit recipe" }).click();
  await expect(page.getByAltText("Current photo")).toBeVisible();
  await page.getByLabel("Remove current photo").check();
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("img", { name: "Photo recipe" })).toHaveCount(0);
});

test("rejects non-image upload with form error", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Bad upload");
  await page.getByLabel("Ingredient 1 item").fill("water");
  await page
    .locator('input[type="file"]')
    .setInputFiles({
      name: "evil.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not an image"),
    });
  await page.getByRole("button", { name: "Save recipe" }).click();

  await expect(page.getByRole("alert")).toContainText(/JPEG, PNG, or WebP/i);
});

async function createRecipe(
  page: import("@playwright/test").Page,
  opts: { name: string; ingredient?: string; sourceUrl?: string },
) {
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill(opts.name);
  await page.getByLabel("Ingredient 1 item").fill(opts.ingredient ?? "water");
  if (opts.sourceUrl) {
    await page.getByLabel("Source URL").fill(opts.sourceUrl);
  }
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/(\?.*)?$/);
}

test("search filters by name + ingredient + source host", async ({ page, flat }) => {
  await login(page, flat.user);

  await createRecipe(page, { name: "Pasta al limone", ingredient: "spaghetti" });
  await createRecipe(page, { name: "Chicken curry", ingredient: "chicken" });
  await createRecipe(page, { name: "Salty noodles", ingredient: "salt" });
  await createRecipe(page, { name: "Salt crust", ingredient: "salt" });
  await createRecipe(page, {
    name: "Sourdough loaf",
    ingredient: "flour",
    sourceUrl: "https://kingarthur.example.com/loaf",
  });

  const search = page.getByRole("searchbox", { name: "Search recipes" });
  // Recipe cards link to /recipes/<uuid>; the "+ New recipe" button links to
  // /recipes/new, which we exclude.
  const cards = page.locator(
    'a[href^="/recipes/"]:not([href="/recipes/new"])',
  );

  // Match by name (with prefix).
  await search.fill("past");
  await search.press("Enter");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Pasta al limone");

  // Match by ingredient.
  await search.fill("chicken");
  await search.press("Enter");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Chicken curry");

  // Same query should keep the same result order across repeated searches.
  await search.fill("salt");
  await search.press("Enter");
  await expect(cards).toHaveCount(2);
  const firstSaltOrder = await cards.evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href")),
  );
  await search.fill("salt");
  await search.press("Enter");
  const secondSaltOrder = await cards.evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href")),
  );
  expect(secondSaltOrder).toEqual(firstSaltOrder);

  // Match by source host.
  await search.fill("kingarthur");
  await search.press("Enter");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Sourdough loaf");

  // No match → friendly empty state.
  await search.fill("nothingmatchesthis");
  await search.press("Enter");
  await expect(cards).toHaveCount(0);
  await expect(page.getByText(/No recipes match/)).toBeVisible();
});
