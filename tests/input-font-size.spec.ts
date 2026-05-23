import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { login } from "./login";

async function expectVisibleFormControlsToUseAtLeast16px(page: Page) {
  const controls = await page
    .locator('input:not([type="hidden"]), textarea, select')
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            control:
              element.getAttribute("aria-label") ??
              element.getAttribute("name") ??
              element.id ??
              element.tagName.toLowerCase(),
            fontSizePx: Number.parseFloat(style.fontSize),
            visible:
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              element.getClientRects().length > 0,
          };
        })
        .filter((element) => element.visible),
    );

  expect(controls.length).toBeGreaterThan(0);

  for (const control of controls) {
    expect(
      control.fontSizePx,
      `${control.control} should render at at least 16px to avoid Safari auto-zoom`,
    ).toBeGreaterThanOrEqual(16);
  }
}

test("visible form controls use at least 16px text to avoid Safari auto-zoom", async ({
  page,
  flat,
}) => {
  await page.goto("/login");
  await expectVisibleFormControlsToUseAtLeast16px(page);

  await login(page, flat.user);
  await expectVisibleFormControlsToUseAtLeast16px(page);

  await page.goto("/recipes/new");
  await expectVisibleFormControlsToUseAtLeast16px(page);

  await page.goto("/flat/settings");
  await page.getByRole("button", { name: /generate/i }).click();
  await expect(page.getByLabel("Invite link")).toBeVisible();
  await expectVisibleFormControlsToUseAtLeast16px(page);

  const inviteUrl = await page.getByLabel("Invite link").inputValue();
  await page.context().clearCookies();
  await page.goto(inviteUrl);
  await expectVisibleFormControlsToUseAtLeast16px(page);
});
