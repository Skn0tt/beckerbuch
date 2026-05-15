import { test, expect } from "./fixtures";

test("home renders empty state", async ({ page, tenant }) => {
  expect(tenant.user.id).toBeTruthy();
  await page.goto("/");
  await expect(page.getByText("No recipes yet")).toBeVisible();
});

