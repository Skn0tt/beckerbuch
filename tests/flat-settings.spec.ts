import { test, expect } from "./fixtures";
import { login } from "./login";
import { seedInvite } from "./tenant";

test("settings shows flat name, current user as member, and a generate button", async ({
  page,
  tenant,
}) => {
  await login(page, tenant.user);
  await page.goto("/flat/settings");

  await expect(page.getByRole("heading", { name: `Flat: ${tenant.flat.name}` })).toBeVisible();
  await expect(page.getByText(tenant.user.displayName)).toBeVisible();
  await expect(page.getByText(tenant.user.email)).toBeVisible();
  await expect(page.getByRole("button", { name: /generate/i })).toBeVisible();
});

test("generate link creates an invite that works", async ({ page, tenant }) => {
  await login(page, tenant.user);
  await page.goto("/flat/settings");
  await page.click("button[type=submit]");

  await expect(page).toHaveURL("/flat/settings");
  const link = page.getByLabel("Invite link");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toContain("/invite/");

  // Visit the generated invite URL in a fresh context — it should show the
  // signup form, not 404.
  const fresh = await page.context().browser()!.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(url);
  await expect(
    freshPage.getByRole("heading", { name: `Join ${tenant.flat.name}` }),
  ).toBeVisible();
  await fresh.close();
});

test("generate new link rotates the previous one", async ({ page, tenant }) => {
  const oldInvite = await seedInvite({
    flatId: tenant.flat.id,
    createdBy: tenant.user.id,
  });
  await login(page, tenant.user);
  await page.goto("/flat/settings");
  await page.click("button[type=submit]");

  const newUrl = await page.getByLabel("Invite link").inputValue();
  expect(newUrl).not.toContain(oldInvite.token);

  // Old token now 404s.
  const fresh = await page.context().browser()!.newContext();
  const freshPage = await fresh.newPage();
  const res = await freshPage.goto(oldInvite.url);
  expect(res?.status()).toBe(404);
  await fresh.close();
});

test("anonymous visit redirects to /login", async ({ page }) => {
  await page.goto("/flat/settings");
  await expect(page).toHaveURL(/\/login\?redirect=/);
});
