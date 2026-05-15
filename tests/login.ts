import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TestUser } from "./fixtures";

/** Wait for client React to hydrate the current page. Set by `<App>`'s
 *  `useEffect`. Must be awaited after any full page load (`goto` /
 *  `reload`) before sending input that depends on a React handler;
 *  pre-hydration clicks land on dead SSR markup and silently no-op. */
export async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "1",
  );
}

export async function login(page: Page, user: Pick<TestUser, "email" | "displayName" | "password">) {
  await page.goto("/login");
  await waitForHydration(page);
  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("textbox", { name: "Password" }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
  // Verify the session actually took effect (catches silent login failures).
  await expect(page.getByTestId("current-user")).toHaveText(user.displayName);
  await waitForHydration(page);
}

