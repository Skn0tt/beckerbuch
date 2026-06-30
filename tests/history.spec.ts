import { expect, test } from "./fixtures";
import { login } from "./login";
import { openAiDedupHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route("https://api.openai.com/v1/chat/completions", openAiDedupHandler());
});

async function createAndCookPasta(
  page: import("@playwright/test").Page,
  flatId: string,
) {
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Pasta al limone");
  await page
    .getByRole("row", { name: "Ingredient 1", exact: true })
    .getByLabel("Amount")
    .fill("400");
  await page
    .getByRole("row", { name: "Ingredient 1", exact: true })
    .getByLabel("Unit")
    .fill("g");
  await page
    .getByRole("row", { name: "Ingredient 1", exact: true })
    .getByLabel("Item")
    .fill("spaghetti");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);

  // Add to draft
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  // Finalise → wait for redirect to /h/:flatId
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flatId}`);

  // Navigate to kitchen stock lane and mark as cooked
  await page.goto("/kitchen?lane=stock");
  await page
    .getByRole("button", { name: "Mark Pasta al limone as cooked" })
    .click();
  await page
    .getByRole("button", { name: "Confirm mark Pasta al limone as cooked" })
    .click();

  // Recipe is removed from in-stock
  await expect(
    page.getByRole("link", { name: "Pasta al limone" }),
  ).toHaveCount(0);
}

test("history: button is visible in stock lane, cooked recipe appears after click", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createAndCookPasta(page, flat.id);

  // History button should be visible in the stock lane
  await expect(
    page.getByRole("button", { name: "Show cooking history" }),
  ).toBeVisible();

  // Click it — the cooked recipe should appear
  await page.getByRole("button", { name: "Show cooking history" }).click();
  await expect(
    page.getByRole("link", { name: "Pasta al limone" }),
  ).toBeVisible();

  // The date should be shown
  const today = new Date().toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  await expect(page.getByText(`Gekocht am ${today}`)).toBeVisible();
});

test("history: not shown by default (button must be pressed first)", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createAndCookPasta(page, flat.id);

  // Before clicking the button, history should NOT be visible
  await expect(
    page.getByRole("link", { name: "Pasta al limone" }),
  ).toHaveCount(0);

  // The "Verlauf anzeigen" trigger button IS visible
  await expect(
    page.getByRole("button", { name: "Show cooking history" }),
  ).toBeVisible();
});

