import { test, expect } from "./fixtures";
import { login } from "./login";
import { seedInvite } from "./tenant";

test("happy path: redeem invite → land on home as new member", async ({
  page,
  tenant,
}) => {
  const invite = await seedInvite({
    flatId: tenant.flat.id,
    createdBy: tenant.user.id,
  });

  await page.goto(invite.url);
  await expect(page.getByRole("heading", { name: `Join ${tenant.flat.name}` })).toBeVisible();

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

test("already-used invite → 404", async ({ page, tenant }) => {
  const invite = await seedInvite({
    flatId: tenant.flat.id,
    createdBy: tenant.user.id,
    used: { byUserId: tenant.user.id },
  });
  const res = await page.goto(invite.url);
  expect(res?.status()).toBe(404);
});

test("expired invite → 404", async ({ page, tenant }) => {
  const invite = await seedInvite({
    flatId: tenant.flat.id,
    createdBy: tenant.user.id,
    expiresAt: new Date(Date.now() - 60_000),
  });
  const res = await page.goto(invite.url);
  expect(res?.status()).toBe(404);
});

test("logged-in user is told they're already in a flat", async ({
  page,
  tenant,
}) => {
  await login(page, tenant.user);
  const invite = await seedInvite({
    flatId: tenant.flat.id,
    createdBy: tenant.user.id,
  });
  await page.goto(invite.url);
  await expect(page.getByRole("heading", { name: /already in a flat/i })).toBeVisible();
  await expect(page.getByText(tenant.flat.name)).toBeVisible();
});

test("weak password is rejected and invite stays usable", async ({
  page,
  tenant,
}) => {
  const invite = await seedInvite({
    flatId: tenant.flat.id,
    createdBy: tenant.user.id,
  });
  await page.goto(invite.url);
  await page.fill("[name=email]", `weak-${Date.now()}@cookbook.test`);
  await page.fill("[name=displayName]", "Weak Picker");
  await page.fill("[name=password]", "short");
  await page.click("button[type=submit]");

  await expect(page.getByText(/at least 12 characters/i)).toBeVisible();
  await expect(page).toHaveURL(invite.url);

  // Reload — should still show the signup form (invite not consumed).
  await page.reload();
  await expect(page.getByRole("heading", { name: `Join ${tenant.flat.name}` })).toBeVisible();
});

test("email already taken → form error, invite not consumed", async ({
  page,
  tenant,
}) => {
  const invite = await seedInvite({
    flatId: tenant.flat.id,
    createdBy: tenant.user.id,
  });
  await page.goto(invite.url);
  // Reuse the tenant's email (their own existing user).
  await page.fill("[name=email]", tenant.user.email);
  await page.fill("[name=displayName]", "Dup Email");
  await page.fill("[name=password]", "cookbook-dup-pw-long");
  await page.click("button[type=submit]");

  await expect(page.getByText(/already exists/i)).toBeVisible();
  await expect(page).toHaveURL(invite.url);

  // Invite still usable: page loads form, not 404.
  const res = await page.goto(invite.url);
  expect(res?.status()).toBe(200);
});
