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

test("add a recipe to draft twice → both show on /kitchen → remove one leaves the other", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);

  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByText(/Added to draft/)).toBeVisible();

  // Same recipe can be added again.
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByText(/Added to draft/)).toBeVisible();

  await page.getByRole("link", { name: "Open Kitchen" }).click();
  await expect(page).toHaveURL("/kitchen");

  await expect(page.getByText(/Draft \(2\)/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Pasta al limone" })).toHaveCount(2);

  await page
    .getByRole("button", { name: "Remove Pasta al limone from draft" })
    .first()
    .click();

  await expect(page.getByText(/Draft \(1\)/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Pasta al limone" })).toHaveCount(1);
});

test("kitchen empty state links back to collection", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "Kitchen" }).click();
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
  await expect(page.getByText(/Added to draft/)).toBeVisible();
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

  await page.getByRole("link", { name: "Kitchen" }).click();
  await expect(page.getByText(/Draft is empty/)).toBeVisible();
});

test("change target portions → ingredients re-scale", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await page.getByRole("link", { name: "Open Kitchen" }).click();

  // Base is 4 portions, 400 g spaghetti. Initially target = 4.
  await expect(page.getByText("400 g spaghetti")).toBeVisible();

  // Bump to 6 portions — 400 * 6/4 = 600.
  await page
    .getByRole("button", { name: "Increase Pasta al limone portions" })
    .click();
  await page
    .getByRole("button", { name: "Increase Pasta al limone portions" })
    .click();
  await expect(page.getByText("600 g spaghetti")).toBeVisible();

  // Decrease to 2 portions — 200 g.
  for (let i = 0; i < 4; i++) {
    await page
      .getByRole("button", { name: "Decrease Pasta al limone portions" })
      .click();
  }
  await expect(page.getByText("200 g spaghetti")).toBeVisible();

  // Floor at 1 portion: try to decrease past 1 — stays at 1.
  await page
    .getByRole("button", { name: "Decrease Pasta al limone portions" })
    .click();
  await expect(page.getByText("100 g spaghetti")).toBeVisible();
});

test("designated cook picker — assign self, then unassign", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await page.getByRole("link", { name: "Open Kitchen" }).click();

  const setSelf = page.getByLabel(
    `Set cook to ${flat.user.displayName} for Pasta al limone`,
  );
  const setUnassigned = page.getByLabel(
    "Set cook to unassigned for Pasta al limone",
  );

  await expect(setUnassigned).toHaveAttribute("aria-pressed", "true");

  await setSelf.click();
  await expect(setSelf).toHaveAttribute("aria-pressed", "true");

  // Reload — choice persisted.
  await page.reload();
  await expect(
    page.getByLabel(`Set cook to ${flat.user.displayName} for Pasta al limone`),
  ).toHaveAttribute("aria-pressed", "true");

  // Unassign.
  await page.getByLabel("Set cook to unassigned for Pasta al limone").click();
  await expect(
    page.getByLabel("Set cook to unassigned for Pasta al limone"),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(
    page.getByLabel("Set cook to unassigned for Pasta al limone"),
  ).toHaveAttribute("aria-pressed", "true");
});

test("promote draft → in-stock lane → mark cooked → empty", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await page.getByRole("link", { name: "Open Kitchen" }).click();

  // Lane defaults to draft.
  await expect(page.getByText(/Draft \(1\)/)).toBeVisible();
  await expect(page.getByText(/In stock \(0\)/)).toBeVisible();

  // Promote to in stock.
  await page
    .getByRole("button", { name: "Move Pasta al limone to in stock" })
    .click();

  await expect(page.getByText(/Draft \(0\)/)).toBeVisible();
  await expect(page.getByText(/In stock \(1\)/)).toBeVisible();

  // Switch to in-stock lane (click the SegmentedControl label).
  await page.getByText(/^In stock \(1\)$/).click();
  await expect(page).toHaveURL(/\?lane=stock$/);
  await expect(page.getByRole("link", { name: "Pasta al limone" })).toBeVisible();
  await expect(page.getByText(/4 portions/)).toBeVisible();
  await expect(page.getByText("400 g spaghetti")).toBeVisible();

  // Mark cooked → leaves the lane.
  await page
    .getByRole("button", { name: "Mark Pasta al limone as cooked" })
    .click();

  await expect(page.getByText(/In stock \(0\)/)).toBeVisible();
  await expect(page.getByText(/Nothing in stock yet/)).toBeVisible();
});

test("reorder draft entries with up/down buttons", async ({ page, flat }) => {
  await login(page, flat.user);
  // Create two distinct recipes.
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await page.getByRole("link", { name: "← Collection" }).click();

  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Risotto");
  await page.getByLabel("Ingredient 1 amount").fill("300");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("rice");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await page.getByRole("link", { name: "Open Kitchen" }).click();

  const cardLinks = page
    .getByRole("link", { name: /Pasta al limone|Risotto/ });

  // Initial order: Pasta first, Risotto second.
  await expect(cardLinks.nth(0)).toHaveText("Pasta al limone");
  await expect(cardLinks.nth(1)).toHaveText("Risotto");

  // First card's ↑ is disabled, last card's ↓ is disabled.
  await expect(
    page.getByRole("button", { name: "Move Pasta al limone up" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Move Risotto down" }),
  ).toBeDisabled();

  // Move Risotto up — should swap with Pasta.
  await page.getByRole("button", { name: "Move Risotto up" }).click();
  await expect(cardLinks.nth(0)).toHaveText("Risotto");
  await expect(cardLinks.nth(1)).toHaveText("Pasta al limone");

  // Reload — order persisted.
  await page.reload();
  const reloadedLinks = page
    .getByRole("link", { name: /Pasta al limone|Risotto/ });
  await expect(reloadedLinks.nth(0)).toHaveText("Risotto");
  await expect(reloadedLinks.nth(1)).toHaveText("Pasta al limone");
});
