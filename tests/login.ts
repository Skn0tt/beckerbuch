import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TestUser } from "./fixtures";

export async function login(page: Page, user: Pick<TestUser, "email" | "displayName" | "password">) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("textbox", { name: "Password" }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
  // Verify the session actually took effect (catches silent login failures).
  await expect(page.getByTestId("current-user")).toHaveText(user.displayName);
}

