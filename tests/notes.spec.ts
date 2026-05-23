import { expect, test } from "./fixtures";
import { login } from "./login";
import { openAiDedupHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route("https://api.openai.com/v1/chat/completions", openAiDedupHandler());
});

async function createPasta(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Pasta al limone");
  await page.getByLabel("Ingredient 1 amount").fill("400");
  await page.getByLabel("Ingredient 1 unit").fill("g");
  await page.getByLabel("Ingredient 1 item").fill("spaghetti");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
}

async function addPastaToDraftAndOpenKitchen(
  page: import("@playwright/test").Page,
) {
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(
    page.getByRole("button", { name: "✓ In draft" }),
  ).toBeVisible();
  await page.goto("/kitchen");
  await expect(page).toHaveURL("/kitchen");
}

test("note: add to draft item, persists across reload", async ({ page, flat }) => {
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  // Empty state: "+ Note" button is visible, no note text yet.
  await expect(
    page.getByRole("button", { name: "Add note for Pasta al limone" }),
  ).toBeVisible();
  await expect(page.getByTestId("note-text")).toHaveCount(0);

  await page
    .getByRole("button", { name: "Add note for Pasta al limone" })
    .click();
  const input = page.getByTestId("note-input");
  await input.fill("cook this on Friday");
  await input.press("Enter");

  await expect(page.getByTestId("note-text")).toHaveText(
    /cook this on Friday/,
  );

  await page.reload();
  await expect(page.getByTestId("note-text")).toHaveText(
    /cook this on Friday/,
  );
});

test("note: edit existing", async ({ page, flat }) => {
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  await page
    .getByRole("button", { name: "Add note for Pasta al limone" })
    .click();
  await page.getByTestId("note-input").fill("first version");
  await page.getByTestId("note-input").press("Enter");
  await expect(page.getByTestId("note-text")).toHaveText(/first version/);

  await page
    .getByRole("button", { name: "Edit note for Pasta al limone" })
    .click();
  const input = page.getByTestId("note-input");
  // The existing value pre-populates the input.
  await expect(input).toHaveValue("first version");
  await input.fill("second version");
  await input.press("Enter");

  await expect(page.getByTestId("note-text")).toHaveText(/second version/);
});

test("note: clearing an existing note returns the + Note button", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  await page
    .getByRole("button", { name: "Add note for Pasta al limone" })
    .click();
  await page.getByTestId("note-input").fill("to be cleared");
  await page.getByTestId("note-input").press("Enter");
  await expect(page.getByTestId("note-text")).toHaveText(/to be cleared/);

  await page
    .getByRole("button", { name: "Edit note for Pasta al limone" })
    .click();
  const input = page.getByTestId("note-input");
  await input.fill("");
  await input.press("Enter");

  await expect(page.getByTestId("note-text")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add note for Pasta al limone" }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("note-text")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add note for Pasta al limone" }),
  ).toBeVisible();
});

test("note: persists through finalise into the in-stock lane", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  await page
    .getByRole("button", { name: "Add note for Pasta al limone" })
    .click();
  await page.getByTestId("note-input").fill("survives finalise");
  await page.getByTestId("note-input").press("Enter");
  await expect(page.getByTestId("note-text")).toHaveText(/survives finalise/);

  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // Back to the kitchen, switch to the In stock lane.
  await page.goto("/kitchen?lane=stock");
  await expect(page.getByTestId("note-text")).toHaveText(/survives finalise/);
});

test("note: editable on in-stock items too", async ({ page, flat }) => {
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  await page.goto("/kitchen?lane=stock");
  await page
    .getByRole("button", { name: "Add note for Pasta al limone" })
    .click();
  await page.getByTestId("note-input").fill("added after finalise");
  await page.getByTestId("note-input").press("Enter");

  await expect(page.getByTestId("note-text")).toHaveText(/added after finalise/);
});

test("note: mobile keeps + Note with controls when empty, moves note below once filled", async ({ page, flat }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  const addNote = page.getByRole("button", { name: "Add note for Pasta al limone" });
  const decreasePortions = page.getByRole("button", {
    name: "Decrease Pasta al limone portions",
  });
  await expect(addNote).toBeVisible();
  await expect(decreasePortions).toBeVisible();

  const controlsContainAddNote = await decreasePortions.evaluate(
    (decreaseEl, addNoteAriaLabel) => {
      let controlsRow: Element | null = null;
      let node: Element | null = decreaseEl;
      while (node) {
        if (
          node.matches('[class*="mantine-Group-root"]') &&
          node.querySelector(
            'button[aria-label="Choose cook for Pasta al limone"]',
          ) != null
        ) {
          controlsRow = node;
          break;
        }
        node = node.parentElement;
      }
      return controlsRow?.querySelector(`button[aria-label="${addNoteAriaLabel}"]`) != null;
    },
    "Add note for Pasta al limone",
  );
  expect(controlsContainAddNote).toBe(true);

  await addNote.click();
  await page.getByTestId("note-input").fill("cook first");
  const waitForSetNote = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/kitchen.data") &&
      r.status() < 400,
  );
  await page.getByTestId("note-input").press("Enter");
  await waitForSetNote;
  await page.reload();
  await expect(page).toHaveURL("/kitchen");

  const note = page.getByTestId("note-text");
  await expect(note).toHaveText(/cook first/);
  const controlsContainNoteText = await decreasePortions.evaluate((decreaseEl) => {
    let controlsRow: Element | null = null;
    let node: Element | null = decreaseEl;
    while (node) {
      if (
        node.matches('[class*="mantine-Group-root"]') &&
        node.querySelector(
          'button[aria-label="Choose cook for Pasta al limone"]',
        ) != null
      ) {
        controlsRow = node;
        break;
      }
      node = node.parentElement;
    }
    return controlsRow?.querySelector('[data-testid="note-text"]') != null;
  });
  expect(controlsContainNoteText).toBe(false);
});

test("note: mobile stock card keeps quantity/avatar on top-right and note/cooked actions on bottom row", async ({
  page,
  flat,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);
  await page.goto("/kitchen?lane=stock");

  const stockCard = page
    .getByRole("link", { name: "Pasta al limone" })
    .locator("xpath=ancestor::*[contains(@class, 'mantine-Card-root')][1]");
  const quantity = stockCard.getByText("4", { exact: true });
  const cookPicker = stockCard.getByRole("button", {
    name: "Choose cook for Pasta al limone",
  });
  const addNote = stockCard.getByRole("button", {
    name: "Add note for Pasta al limone",
  });
  const markCooked = stockCard.getByRole("button", {
    name: "Mark Pasta al limone as cooked",
  });

  await expect(quantity).toBeVisible();
  await expect(cookPicker).toBeVisible();
  await expect(addNote).toBeVisible();
  await expect(markCooked).toHaveText("✓");

  const quantityRect = await quantity.evaluate((el) => el.getBoundingClientRect());
  const cookPickerRect = await cookPicker.evaluate((el) => el.getBoundingClientRect());
  const addNoteRect = await addNote.evaluate((el) => el.getBoundingClientRect());
  const markCookedRect = await markCooked.evaluate((el) => el.getBoundingClientRect());

  expect(quantityRect.y).toBeLessThan(addNoteRect.y);
  expect(cookPickerRect.y).toBeLessThan(addNoteRect.y);
  expect(markCookedRect.y).toBeLessThan(addNoteRect.y + addNoteRect.height);
  expect(addNoteRect.y).toBeLessThan(markCookedRect.y + markCookedRect.height);
  expect(addNoteRect.x).toBeLessThan(markCookedRect.x);
});

test("note: does NOT appear on the public /h/:flatId handoff page", async ({
  page,
  flat,
  browser,
}) => {
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  await page
    .getByRole("button", { name: "Add note for Pasta al limone" })
    .click();
  await page
    .getByTestId("note-input")
    .fill("internal note - should not leak");
  await page.getByTestId("note-input").press("Enter");
  await expect(page.getByTestId("note-text")).toHaveText(
    /internal note - should not leak/,
  );

  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // Anonymous visitor on the public handoff page.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/h/${flat.id}`);

  // Recipe link present (use the "(serves N)" suffix to avoid matching
  // the Bring! deep-link button which also mentions the recipe name).
  await expect(
    anonPage.getByRole("link", { name: /Pasta al limone \(serves 4\)/ }),
  ).toBeVisible();
  // Note text absent.
  await expect(anonPage.getByText(/internal note/)).toHaveCount(0);

  await anon.close();
});
