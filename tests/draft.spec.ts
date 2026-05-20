import { expect, test } from "./fixtures";
import { login } from "./login";
import { mockOpenAiDedup } from "./proxy/mocks";

// Finalise triggers dedup → OpenAI. Mock it so tests don't hit the
// real API (which they couldn't, anyway — no real key in test).
test.beforeEach(async ({ httpMocks }) => {
  await mockOpenAiDedup(httpMocks);
});

async function createPasta(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Pasta al limone");
  await page.getByLabel("Ingredient 1 amount").fill("400");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("spaghetti");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
}

test("add a recipe to draft → button flips to 'In draft' → kitchen shows one entry → remove → can add again", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);

  await page.getByRole("button", { name: "+ Add to draft" }).click();
  // Button replaced with the "In draft" indicator.
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ Add to draft" }),
  ).toHaveCount(0);

  const recipeUrl = page.url();

  await page.goto("/kitchen");
  await expect(page).toHaveURL("/kitchen");

  // Only one instance even after a no-op re-click would happen.
  await expect(page.getByText("Draft 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pasta al limone" })).toHaveCount(1);

  // Step the portions to 0 → opens the remove-confirm modal → confirm.
  // Base is 4 portions; click − 4 times.
  for (let i = 0; i < 4; i++) {
    await page
      .getByRole("button", { name: "Decrease Pasta al limone portions" })
      .click();
  }
  await page
    .getByRole("button", { name: "Confirm remove Pasta al limone from draft" })
    .click();

  await expect(page.getByRole("link", { name: "Pasta al limone" })).toHaveCount(0);

  // Back on the recipe page the add button returns.
  await page.goto(recipeUrl);
  await expect(
    page.getByRole("button", { name: "+ Add to draft" }),
  ).toBeVisible();
});

test("kitchen empty state links back to collection", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.goto("/kitchen");
  await expect(page).toHaveURL("/kitchen");
  await expect(page.getByText(/Draft is empty/)).toBeVisible();
});

test("draft is scoped to the flat — other flat's draft is invisible", async ({
  page,
  flat,
  request,
}) => {
  // Flat A adds a recipe to its draft.
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
  await page.context().clearCookies();

  // Spin up a fresh flat B.
  const adminRes = await request.post("/admin/tenants", {
    data: {},
    headers: { "X-Admin-Token": "test-admin-token" },
  });
  const { inviteUrl } = (await adminRes.json()) as { inviteUrl: string };
  await page.goto(inviteUrl);
  await page.getByLabel("Email").fill(`other-${Date.now()}@cookbook.test`);
  await page.getByLabel("Display name").fill("Other Cook");
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("cookbook-other-password");
  await page.getByRole("button", { name: "Create account & join" }).click();
  await page.waitForURL("/");

  await page.goto("/kitchen");
  await expect(page.getByText(/Draft is empty/)).toBeVisible();
});

test("change target portions → ingredients re-scale", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  // The recipe view shows ingredients scaled to the draft target.
  // Base is 4 portions, 400 g spaghetti. Initially target = 4.
  await expect(page.getByText("400 g spaghetti")).toBeVisible();

  // Use the kitchen sidebar stepper (visible on desktop) to bump to 6.
  await page
    .getByRole("button", { name: "Increase Pasta al limone portions" })
    .click();
  await page
    .getByRole("button", { name: "Increase Pasta al limone portions" })
    .click();
  await expect(page.getByText("600 g spaghetti")).toBeVisible();

  // Decrease to 1 portion — 100 g.
  for (let i = 0; i < 5; i++) {
    await page
      .getByRole("button", { name: "Decrease Pasta al limone portions" })
      .click();
  }
  await expect(page.getByText("100 g spaghetti")).toBeVisible();

  // Stepping below 1 opens the remove-confirm modal — cancel it.
  await page
    .getByRole("button", { name: "Decrease Pasta al limone portions" })
    .click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("100 g spaghetti")).toBeVisible();
});

test("designated cook picker — assign self, then unassign", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
  await page.goto("/kitchen");

  const openPicker = page.getByLabel("Choose cook for Pasta al limone");
  await openPicker.click();
  const setSelf = page.getByLabel(`Set cook to ${flat.user.displayName} for Pasta al limone`);
  const setUnassigned = page.getByLabel("Set cook to unassigned for Pasta al limone");

  await expect(setUnassigned).toHaveAttribute("aria-pressed", "true");
  await setSelf.click();

  // Reload — choice persisted.
  await page.reload();
  await page.getByLabel("Choose cook for Pasta al limone").click();
  await expect(page.getByLabel(`Set cook to ${flat.user.displayName} for Pasta al limone`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Unassign.
  await page.getByLabel("Choose cook for Pasta al limone").click();
  await page.getByLabel("Set cook to unassigned for Pasta al limone").click();
  await page.reload();
  await page.getByLabel("Choose cook for Pasta al limone").click();
  await expect(
    page.getByLabel("Set cook to unassigned for Pasta al limone"),
  ).toHaveAttribute("aria-pressed", "true");
});

test("designated cook can be edited in stock lane", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In draft" }),
  ).toBeVisible();
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(/\/h\/[0-9a-f-]{36}$/);
  await page.goto("/kitchen?lane=stock");

  await page.getByLabel("Choose cook for Pasta al limone").click();
  await page
    .getByLabel(`Set cook to ${flat.user.displayName} for Pasta al limone`)
    .click();
  await page.reload();
  await page.getByLabel("Choose cook for Pasta al limone").click();
  await expect(
    page.getByLabel(`Set cook to ${flat.user.displayName} for Pasta al limone`),
  ).toHaveAttribute("aria-pressed", "true");
});

test("finalise draft → in-stock lane → mark cooked → empty", async ({
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

  // Lane defaults to draft.
  await expect(page.getByText("Draft 1", { exact: true })).toBeVisible();
  await expect(page.getByText("In stock 0", { exact: true })).toBeVisible();

  // Finalise the draft → redirects to handoff page.
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page
    .getByRole("button", { name: "Confirm finalise draft" })
    .click();
  await expect(page).toHaveURL(/\/h\/[0-9a-f-]{36}$/);

  // Back to kitchen — draft is empty, stock has 1.
  await page.goto("/kitchen");
  await expect(page.getByText("Draft 0", { exact: true })).toBeVisible();
  await expect(page.getByText("In stock 1", { exact: true })).toBeVisible();

  // Switch to in-stock lane (click the visible label).
  await page.getByText("In stock 1", { exact: true }).click();
  await expect(page).toHaveURL(/\?lane=stock$/);
  await expect(page.getByRole("link", { name: "Pasta al limone" })).toBeVisible();

  // Mark cooked → opens confirm modal → confirm → leaves the lane.
  await page
    .getByRole("button", { name: "Mark Pasta al limone as cooked" })
    .click();
  await page
    .getByRole("button", { name: "Confirm mark Pasta al limone as cooked" })
    .click();

  await expect(page.getByText("In stock 0", { exact: true })).toBeVisible();
  await expect(page.getByText(/Nothing in stock yet/)).toBeVisible();
});
