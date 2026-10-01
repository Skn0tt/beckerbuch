import { expect, test } from "./fixtures";
import { login } from "./login";
import { geminiEmbeddingHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route(
    "https://generativelanguage.googleapis.com/**",
    geminiEmbeddingHandler(),
  );
});

async function createPasta(page: import("@playwright/test").Page) {
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
}

async function addPastaToDraftAndOpenKitchen(
  page: import("@playwright/test").Page,
) {
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
  await page.goto("/kitchen");
  await expect(page).toHaveURL("/kitchen");
}

test("note: add to draft item, persists across reload", async ({
  page,
  flat,
}) => {
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
  // set-note is fire-and-forget useFetcher — wait for the POST before
  // reload so persistence isn't racing an in-flight write.
  const waitForSetNote = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/kitchen.data") &&
      r.status() < 400,
  );
  await input.press("Enter");
  await waitForSetNote;

  await expect(page.getByTestId("note-text")).toHaveText(/cook this on Friday/);

  await page.reload();
  await expect(page.getByTestId("note-text")).toHaveText(/cook this on Friday/);
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
  // set-note is fire-and-forget useFetcher — wait for the POST before
  // reload, otherwise the optimistic clear can pass while the DB write
  // is still in flight and the note comes back after reload.
  const waitForClearNote = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/kitchen.data") &&
      r.status() < 400,
  );
  await input.press("Enter");
  await waitForClearNote;

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

  await expect(page.getByTestId("note-text")).toHaveText(
    /added after finalise/,
  );
});

test("note: draft card keeps the stepper with the title, and cook with the note", async ({
  page,
  flat,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);

  const card = page
    .getByRole("link", { name: "Pasta al limone" })
    .locator("xpath=ancestor::*[contains(@class, 'mantine-Card-root')][1]");
  const title = card.getByRole("link", { name: "Pasta al limone" });
  const decrease = card.getByRole("button", {
    name: "Decrease Pasta al limone portions",
  });
  const cook = card.getByRole("button", {
    name: "Choose cook for Pasta al limone",
  });
  const addNote = card.getByRole("button", {
    name: "Add note for Pasta al limone",
  });

  await expect(decrease).toBeVisible();
  await expect(addNote).toBeVisible();

  const titleRect = await title.boundingBox();
  const decreaseRect = await decrease.boundingBox();
  const cookRect = await cook.boundingBox();
  const addNoteRect = await addNote.boundingBox();
  expect(titleRect).not.toBeNull();
  expect(decreaseRect).not.toBeNull();
  expect(cookRect).not.toBeNull();
  expect(addNoteRect).not.toBeNull();
  const midY = (box: { y: number; height: number }) => box.y + box.height / 2;
  // Stepper shares the title row; cook and + Note share the row below.
  expect(Math.abs(midY(titleRect!) - midY(decreaseRect!))).toBeLessThan(8);
  expect(midY(cookRect!)).toBeGreaterThan(midY(titleRect!) + 8);
  expect(Math.abs(midY(cookRect!) - midY(addNoteRect!))).toBeLessThan(8);
  expect(cookRect!.x).toBeLessThan(addNoteRect!.x);

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

  const note = card.getByTestId("note-text");
  await expect(note).toHaveText(/cook first/);
  const noteRect = await note.boundingBox();
  const cookAfter = await cook.boundingBox();
  const decreaseAfter = await decrease.boundingBox();
  expect(noteRect).not.toBeNull();
  expect(cookAfter).not.toBeNull();
  expect(decreaseAfter).not.toBeNull();
  const midYAfter = (box: { y: number; height: number }) =>
    box.y + box.height / 2;
  expect(midYAfter(cookAfter!)).toBeGreaterThan(midYAfter(decreaseAfter!) + 8);
  expect(Math.abs(midYAfter(cookAfter!) - midYAfter(noteRect!))).toBeLessThan(
    8,
  );
  expect(cookAfter!.x).toBeLessThan(noteRect!.x);
});

test("note: mobile stock card keeps title top, quantity top-right, and avatar/note/cooked on one row", async ({
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
  const recipeTitle = stockCard.getByRole("link", { name: "Pasta al limone" });
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

  const titleRect = await recipeTitle.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const quantityRect = await quantity.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const cookPickerRect = await cookPicker.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const addNoteRect = await addNote.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const markCookedRect = await markCooked.evaluate((el) =>
    el.getBoundingClientRect(),
  );

  expect(titleRect.y).toBeLessThan(cookPickerRect.y - 2);
  expect(quantityRect.y).toBeLessThan(cookPickerRect.y - 2);
  expect(titleRect.x).toBeLessThan(quantityRect.x);
  expect(cookPickerRect.y).toBeLessThan(addNoteRect.y + addNoteRect.height);
  expect(addNoteRect.y).toBeLessThan(cookPickerRect.y + cookPickerRect.height);
  expect(markCookedRect.y).toBeLessThan(addNoteRect.y + addNoteRect.height);
  expect(addNoteRect.y).toBeLessThan(markCookedRect.y + markCookedRect.height);
  expect(cookPickerRect.x).toBeLessThan(addNoteRect.x);
  expect(addNoteRect.x).toBeLessThan(markCookedRect.x);
});

test("note: desktop stock card keeps title top, quantity top-right, and avatar/note/cooked on one row", async ({
  page,
  flat,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, flat.user);
  await addPastaToDraftAndOpenKitchen(page);
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);
  await page.goto("/kitchen?lane=stock");

  const stockCard = page
    .getByRole("link", { name: "Pasta al limone" })
    .locator("xpath=ancestor::*[contains(@class, 'mantine-Card-root')][1]");
  const recipeTitle = stockCard.getByRole("link", { name: "Pasta al limone" });
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

  const titleRect = await recipeTitle.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const quantityRect = await quantity.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const cookPickerRect = await cookPicker.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const addNoteRect = await addNote.evaluate((el) =>
    el.getBoundingClientRect(),
  );
  const markCookedRect = await markCooked.evaluate((el) =>
    el.getBoundingClientRect(),
  );

  expect(titleRect.y).toBeLessThan(cookPickerRect.y - 2);
  expect(quantityRect.y).toBeLessThan(cookPickerRect.y - 2);
  expect(titleRect.x).toBeLessThan(quantityRect.x);
  expect(cookPickerRect.y).toBeLessThan(addNoteRect.y + addNoteRect.height);
  expect(addNoteRect.y).toBeLessThan(cookPickerRect.y + cookPickerRect.height);
  expect(markCookedRect.y).toBeLessThan(addNoteRect.y + addNoteRect.height);
  expect(addNoteRect.y).toBeLessThan(markCookedRect.y + markCookedRect.height);
  expect(cookPickerRect.x).toBeLessThan(addNoteRect.x);
  expect(addNoteRect.x).toBeLessThan(markCookedRect.x);
});

test("sidebar: draft and in-stock quantity numbers share a column", async ({
  page,
  flat,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, flat.user);
  await createPasta(page);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  await expect(page).toHaveURL(`/h/${flat.id}`);

  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill("Ofengemüse");
  await page
    .getByRole("row", { name: "Ingredient 1", exact: true })
    .getByLabel("Amount")
    .fill("2");
  await page
    .getByRole("row", { name: "Ingredient 1", exact: true })
    .getByLabel("Unit")
    .fill("piece");
  await page
    .getByRole("row", { name: "Ingredient 1", exact: true })
    .getByLabel("Item")
    .fill("zucchini");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "Kitchen" });
  const draftCard = sidebar
    .getByRole("link", { name: "Ofengemüse" })
    .locator("xpath=ancestor::*[contains(@class, 'mantine-Card-root')][1]");
  const stockCard = sidebar
    .getByRole("link", { name: "Pasta al limone" })
    .locator("xpath=ancestor::*[contains(@class, 'mantine-Card-root')][1]");

  const draftQty = draftCard.getByText("4", { exact: true });
  const stockQty = stockCard.getByText("4", { exact: true });
  const draftCook = draftCard.getByRole("button", {
    name: "Choose cook for Ofengemüse",
  });
  const stockCook = stockCard.getByRole("button", {
    name: "Choose cook for Pasta al limone",
  });
  const draftNote = draftCard.getByRole("button", {
    name: "Add note for Ofengemüse",
  });
  const stockNote = stockCard.getByRole("button", {
    name: "Add note for Pasta al limone",
  });
  const increase = draftCard.getByRole("button", {
    name: "Increase Ofengemüse portions",
  });
  const cooked = stockCard.getByRole("button", {
    name: "Mark Pasta al limone as cooked",
  });

  await expect(draftQty).toBeVisible();
  await expect(stockQty).toBeVisible();

  const draftQtyBox = await draftQty.boundingBox();
  const stockQtyBox = await stockQty.boundingBox();
  const draftCookBox = await draftCook.boundingBox();
  const stockCookBox = await stockCook.boundingBox();
  const draftNoteBox = await draftNote.boundingBox();
  const stockNoteBox = await stockNote.boundingBox();
  const increaseBox = await increase.boundingBox();
  const cookedBox = await cooked.boundingBox();
  for (const box of [
    draftQtyBox,
    stockQtyBox,
    draftCookBox,
    stockCookBox,
    draftNoteBox,
    stockNoteBox,
    increaseBox,
    cookedBox,
  ]) {
    expect(box).not.toBeNull();
  }

  expect(Math.abs(draftQtyBox!.x - stockQtyBox!.x)).toBeLessThan(2);
  expect(Math.abs(draftCookBox!.x - stockCookBox!.x)).toBeLessThan(2);
  expect(Math.abs(draftNoteBox!.x - stockNoteBox!.x)).toBeLessThan(2);
  const right = (box: { x: number; width: number }) => box.x + box.width;
  expect(Math.abs(right(increaseBox!) - right(cookedBox!))).toBeLessThan(2);

  const midY = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(Math.abs(midY(draftCookBox!) - midY(draftNoteBox!))).toBeLessThan(8);
  expect(Math.abs(midY(stockCookBox!) - midY(stockNoteBox!))).toBeLessThan(8);
  expect(Math.abs(midY(stockCookBox!) - midY(cookedBox!))).toBeLessThan(8);
  expect(midY(draftCookBox!)).toBeGreaterThan(midY(draftQtyBox!) + 8);
  expect(midY(stockCookBox!)).toBeGreaterThan(midY(stockQtyBox!) + 8);
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
  await page.getByTestId("note-input").fill("internal note - should not leak");
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
