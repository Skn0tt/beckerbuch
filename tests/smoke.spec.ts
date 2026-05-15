import { test, expect } from "./fixtures";
import { login } from "./login";

test("home renders empty state when logged in", async ({ page, tenant }) => {
  await login(page, tenant.user);
  await expect(page.getByText("No recipes yet")).toBeVisible();
});

test("home redirects to /login when anonymous", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=/);
});


