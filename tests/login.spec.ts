import { test, expect } from "./fixtures";
import { login } from "./login";

test("happy path: log in lands on home", async ({ page, tenant }) => {
  await login(page, tenant.user);
  await expect(page).toHaveURL("/");
  await expect(page.getByText(`Sign out ${tenant.user.displayName}`)).toBeVisible();
});

test("wrong password shows error and stays on /login", async ({ page, tenant }) => {
  await page.goto("/login");
  await page.fill("[name=email]", tenant.user.email);
  await page.fill("[name=password]", "totally-wrong-password");
  await page.click("button[type=submit]");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("alert")).toContainText(/invalid/i);
});

test("unknown email shows the same generic error", async ({ page }) => {
  await page.goto("/login");
  await page.fill("[name=email]", "nobody-here@cookbook.test");
  await page.fill("[name=password]", "whatever-password");
  await page.click("button[type=submit]");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("alert")).toContainText(/invalid/i);
});

test("redirect-after-login preserves the original target", async ({ page, tenant }) => {
  await page.goto("/?welcome=1");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.fill("[name=email]", tenant.user.email);
  await page.fill("[name=password]", tenant.user.password);
  await page.click("button[type=submit]");
  await expect(page).toHaveURL("/?welcome=1");
});

test("open-redirect via ?redirect= is rejected", async ({ page, tenant }) => {
  await page.goto("/login?redirect=https://evil.example/owned");
  await page.fill("[name=email]", tenant.user.email);
  await page.fill("[name=password]", tenant.user.password);
  await page.click("button[type=submit]");
  await expect(page).toHaveURL("/");
});

test("logout returns to /login and home is gated again", async ({ page, tenant }) => {
  await login(page, tenant.user);
  await page.click(`button:has-text("Sign out ${tenant.user.displayName}")`);
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=/);
});
