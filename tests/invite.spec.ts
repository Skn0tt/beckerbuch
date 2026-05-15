import type { Page } from "@playwright/test";
import { test, expect, generateInvite } from "./fixtures";

async function fillSignup(
  page: Page,
  opts: { email: string; displayName: string; password: string },
) {
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Display name").fill(opts.displayName);
  await page.getByRole("textbox", { name: "Password" }).fill(opts.password);
  await page.getByRole("button", { name: "Create account & join" }).click();
}

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
  await fillSignup(page, {
    email: newEmail,
    displayName: newName,
    password: "cookbook-redeemer-pw",
  });

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("button", { name: `Sign out ${newName}` })).toBeVisible();
});

test("invalid token → 404", async ({ page }) => {
  const res = await page.goto("/invite/this-token-does-not-exist");
  expect(res?.status()).toBe(404);
});

test("already-used invite → 404", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  await page.context().clearCookies();

  await page.goto(inviteUrl);
  await fillSignup(page, {
    email: `first-${Date.now()}@cookbook.test`,
    displayName: "First Redeemer",
    password: "cookbook-first-pw",
  });
  await page.waitForURL("/");
  await page.context().clearCookies();

  const res = await page.goto(inviteUrl);
  expect(res?.status()).toBe(404);
});

test("logged-in user is told they're already in a flat", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  // Stay logged in.

  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: /already in a flat/i })).toBeVisible();
  await expect(page.getByText(flat.name)).toBeVisible();
});

test("weak password is rejected and invite stays usable", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  await page.context().clearCookies();

  await page.goto(inviteUrl);
  await fillSignup(page, {
    email: `weak-${Date.now()}@cookbook.test`,
    displayName: "Weak Picker",
    password: "short",
  });

  await expect(page.getByText(/at least 12 characters/i)).toBeVisible();
  await expect(page).toHaveURL(inviteUrl);

  // Reload — invite still usable.
  await page.reload();
  await expect(page.getByRole("heading", { name: `Join ${flat.name}` })).toBeVisible();
});

test("email already taken → form error, invite not consumed", async ({ page, flat }) => {
  const inviteUrl = await generateInvite(page, flat.user);
  await page.context().clearCookies();

  await page.goto(inviteUrl);
  await fillSignup(page, {
    email: flat.user.email,
    displayName: "Dup Email",
    password: "cookbook-dup-pw-long",
  });

  await expect(page.getByText(/already exists/i)).toBeVisible();
  await expect(page).toHaveURL(inviteUrl);

  // Invite still usable: page loads form, not 404.
  const res = await page.goto(inviteUrl);
  expect(res?.status()).toBe(200);
});
