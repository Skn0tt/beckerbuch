import { test, expect, generateInvite } from "./fixtures";
import { login } from "./login";

test("settings shows flat name, current user as member, and a generate button", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "Flat settings" }).click();

  await expect(page.getByRole("heading", { name: `Flat: ${flat.name}` })).toBeVisible();
  await expect(page.getByText(flat.user.displayName)).toBeVisible();
  await expect(page.getByText(flat.user.email)).toBeVisible();
  await expect(page.getByRole("button", { name: /generate/i })).toBeVisible();
});

test("generate link creates an invite that works", async ({ page, flat }) => {
  const url = await generateInvite(page, flat.user);
  expect(url).toContain("/invite/");

  // Visit the generated invite URL in a fresh context — it should show the
  // signup form, not 404.
  const fresh = await page.context().browser()!.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(url);
  await expect(
    freshPage.getByRole("heading", { name: `Join ${flat.name}` }),
  ).toBeVisible();
  await fresh.close();
});

test("generate new link rotates the previous one", async ({ page, flat }) => {
  const oldUrl = await generateInvite(page, flat.user);

  // Click Generate again — rotates to a fresh token.
  await page.getByRole("button", { name: /generate/i }).click();
  await expect
    .poll(() => page.getByLabel("Invite link").inputValue())
    .not.toBe(oldUrl);

  // Old URL now 404s.
  const fresh = await page.context().browser()!.newContext();
  const freshPage = await fresh.newPage();
  const res = await freshPage.goto(oldUrl);
  expect(res?.status()).toBe(404);
  await fresh.close();
});

test("anonymous visit redirects to /login", async ({ page }) => {
  await page.goto("/flat/settings");
  await expect(page).toHaveURL(/\/login\?redirect=/);
});
