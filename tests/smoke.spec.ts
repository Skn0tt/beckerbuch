import { test, expect } from "./fixtures";
import { login } from "./login";

test("home renders empty state when logged in", async ({ page, flat }) => {
  await login(page, flat.user);
  await expect(page.getByRole("heading", { name: "Draft" })).toBeVisible();
  await expect(page.getByText("No recipes yet")).toBeVisible();
});

test("home redirects to /login when anonymous", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\/?\?redirect=/);
});

test("hovering + New recipe prefetches its route data", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "+ New recipe" }).hover();
  await expect
    .poll(() =>
      page.evaluate(() =>
        !!document.head.querySelector('link[rel="prefetch"][href*="/recipes/new"]'),
      ),
    )
    .toBe(true);
});
