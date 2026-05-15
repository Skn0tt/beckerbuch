import { test, expect, generateInvite } from "./fixtures";

test("happy path: redeem invite → land on home as new member", async ({
  page,
  flat,
}) => {
  const inviteUrl = await generateInvite(page, flat.user);
  await page.context().clearCookies();

  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: `Join ${flat.name}` })).toBeVisible();

  const newEmail = `redeemer-${Date.now()}-${Math.random().toString(36).slice(2)}@cookbook.test`;
  const newName = "Redeemer Cook";
  await page.fill("[name=email]", newEmail);
  await page.fill("[name=displayName]", newName);
  await page.fill("[name=password]", "cookbook-redeemer-pw");
  await page.click("button[type=submit]");

  await expect(page).toHaveURL("/");
  await expect(page.getByText(`Sign out ${newName}`)).toBeVisible();
});

test("invalid token → 404", async ({ page }) => {
  const res = await page.goto("/invite/this-token-does-not-exist");
  expect(res?.status()).toBe(404);
});

test("already-used invite → 404", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  await page.context().clearCookies();

  // Redeem it once.
  await page.goto(inviteUrl);
  await page.fill("[name=email]", `first-${Date.now()}@cookbook.test`);
  await page.fill("[name=displayName]", "First Redeemer");
  await page.fill("[name=password]", "cookbook-first-pw");
  await page.click("button[type=submit]");
  await page.waitForURL("/");
  await page.context().clearCookies();

  // Visiting the same URL again → 404.
  const res = await page.goto(inviteUrl);
  expect(res?.status()).toBe(404);
});

test("logged-in user is told they're already in a flat", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  // Stay logged in (don't clear cookies).

  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: /already in a flat/i })).toBeVisible();
  await expect(page.getByText(flat.name)).toBeVisible();
});

test("weak password is rejected and invite stays usable", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  await page.context().clearCookies();

  await page.goto(inviteUrl);
  await page.fill("[name=email]", `weak-${Date.now()}@cookbook.test`);
  await page.fill("[name=displayName]", "Weak Picker");
  await page.fill("[name=password]", "short");
  await page.click("button[type=submit]");

  await expect(page.getByText(/at least 12 characters/i)).toBeVisible();
  await expect(page).toHaveURL(inviteUrl);

  // Reload — should still show the signup form (invite not consumed).
  await page.reload();
  await expect(page.getByRole("heading", { name: `Join ${flat.name}` })).toBeVisible();
});

test("email already taken → form error, invite not consumed", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  await page.context().clearCookies();

  await page.goto(inviteUrl);
  // Reuse the founder's email.
  await page.fill("[name=email]", flat.user.email);
  await page.fill("[name=displayName]", "Dup Email");
  await page.fill("[name=password]", "cookbook-dup-pw-long");
  await page.click("button[type=submit]");

  await expect(page.getByText(/already exists/i)).toBeVisible();
  await expect(page).toHaveURL(inviteUrl);

  // Invite still usable: page loads form, not 404.
  const res = await page.goto(inviteUrl);
  expect(res?.status()).toBe(200);
});
