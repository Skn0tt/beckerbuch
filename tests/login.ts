import type { Page } from "@playwright/test";
import type { TestUser } from "./fixtures";

export async function login(page: Page, user: Pick<TestUser, "email" | "password">) {
  await page.goto("/login");
  await page.fill("[name=email]", user.email);
  await page.fill("[name=password]", user.password);
  await page.click("button[type=submit]");
  await page.waitForURL("/");
}

