import { test, expect } from "./fixtures";
import { login } from "./login";

test("happy path: log in lands on home", async ({ page, flat }) => {
  await login(page, flat.user);
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("current-user")).toHaveText(flat.user.displayName);
});

test("wrong password shows error and stays on /login", async ({ page, flat }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(flat.user.email);
  await page.getByRole("textbox", { name: "Password" }).fill("totally-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("alert")).toContainText(/invalid/i);
});

test("unknown email shows the same generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("nobody-here@cookbook.test");
  await page.getByRole("textbox", { name: "Password" }).fill("whatever-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("alert")).toContainText(/invalid/i);
});

test("redirect-after-login preserves the original target", async ({ page, flat }) => {
  await page.goto("/?welcome=1");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.getByLabel("Email").fill(flat.user.email);
  await page.getByRole("textbox", { name: "Password" }).fill(flat.user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/?welcome=1");
});

test("open-redirect via ?redirect= is rejected", async ({ page, flat }) => {
  await page.goto("/login?redirect=https://evil.example/owned");
  await page.getByLabel("Email").fill(flat.user.email);
  await page.getByRole("textbox", { name: "Password" }).fill(flat.user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
});

test("logout returns to /login and home is gated again", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=/);
});
