import { expect, test } from "./fixtures";
import { login } from "./login";
import { openAiEmbeddingHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route(
    "https://api.openai.com/v1/embeddings",
    openAiEmbeddingHandler(),
  );
});

// Two-ingredient recipe: spaghetti + lemons.
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
  await page
    .getByRole("row", { name: "Ingredient 2", exact: true })
    .getByLabel("Amount")
    .fill("2");
  await page
    .getByRole("row", { name: "Ingredient 2", exact: true })
    .getByLabel("Item")
    .fill("lemons");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
}

async function addToDraft(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
}

async function finaliseDraft(page: import("@playwright/test").Page) {
  await page.goto("/kitchen");
  await page.getByRole("button", { name: "Finalise draft" }).click();
  await page.getByRole("button", { name: "Confirm finalise draft" }).click();
  // Wait for the finalise to commit (redirects to the handoff page) before
  // the caller navigates away — otherwise the in-flight POST can be cancelled.
  await page.waitForURL(/\/h\//);
}

test("drafted recipe: omit strikes the line, restore brings it back", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  await addToDraft(page);

  const line = page.getByText("400 g spaghetti");
  await expect(line).toHaveCSS("text-decoration-line", "none");

  await page.getByRole("button", { name: "Omit spaghetti" }).click();
  await expect(
    page.getByRole("button", { name: "Include spaghetti" }),
  ).toBeVisible();
  await expect(line).toHaveCSS("text-decoration-line", "line-through");

  await page.getByRole("button", { name: "Include spaghetti" }).click();
  await expect(
    page.getByRole("button", { name: "Omit spaghetti" }),
  ).toBeVisible();
  await expect(line).toHaveCSS("text-decoration-line", "none");
});

test("recipe not in a draft: no omit toggle", async ({ page, flat }) => {
  await login(page, flat.user);
  await createPasta(page);

  await expect(page.getByText("400 g spaghetti")).toBeVisible();
  await expect(page.getByRole("button", { name: "Omit spaghetti" })).toHaveCount(
    0,
  );
});

test("desktop (hover pointer): toggle is hidden until row hover, but stays visible once omitted", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  await addToDraft(page);

  const omit = page.getByRole("button", { name: "Omit spaghetti" });
  // At rest the mouse is off the row, so the toggle is transparent.
  await expect(omit).toHaveCSS("opacity", "0");

  // Hovering the ingredient line reveals it.
  await page.getByText("400 g spaghetti").hover();
  await expect(omit).toHaveCSS("opacity", "1");

  // Omit it, then move the mouse away — an omitted line keeps its toggle
  // visible so the struck-through state stays reachable without hovering.
  await omit.click();
  await page.mouse.move(2, 2);
  await expect(
    page.getByRole("button", { name: "Include spaghetti" }),
  ).toHaveCSS("opacity", "1");
});

test.describe("touch device (no hover pointer)", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("toggle is always visible at rest", async ({ page, flat }) => {
    await login(page, flat.user);
    await createPasta(page);
    await addToDraft(page);

    // No hover to rely on, so the toggle must be visible without interaction.
    await expect(
      page.getByRole("button", { name: "Omit spaghetti" }),
    ).toHaveCSS("opacity", "1");
  });
});


test("in stock: recipe page renders plainly, no toggle for a previously omitted line", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  const recipeUrl = page.url();
  await addToDraft(page);
  await page.getByRole("button", { name: "Omit lemons" }).click();
  await expect(
    page.getByRole("button", { name: "Include lemons" }),
  ).toBeVisible();

  await finaliseDraft(page);

  // Back on the recipe page — now in stock.
  await page.goto(recipeUrl);
  await expect(page.getByText("2 lemons")).toBeVisible();
  await expect(page.getByText("2 lemons")).toHaveCSS(
    "text-decoration-line",
    "none",
  );
  await expect(page.getByRole("button", { name: "Omit lemons" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Include lemons" })).toHaveCount(
    0,
  );
});

test("finalise excludes an omitted ingredient from the shopping list + JSON-LD", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  await addToDraft(page);
  await page.getByRole("button", { name: "Omit lemons" }).click();
  await expect(
    page.getByRole("button", { name: "Include lemons" }),
  ).toBeVisible();

  await finaliseDraft(page);
  await expect(page).toHaveURL(`/h/${flat.id}`);

  // The combined shopping list (what feeds Bring!) keeps spaghetti and
  // drops the omitted lemons. The per-recipe breakdown below still lists
  // every ingredient, so scope this assertion to the combined list.
  const combined = page.getByTestId("combined-list");
  await expect(combined.getByText("400 g spaghetti")).toBeVisible();
  await expect(combined.getByText("2 lemons")).toHaveCount(0);

  const jsonLd = JSON.parse(
    (await page
      .locator('script[type="application/ld+json"]')
      .textContent())!,
  );
  expect(jsonLd.recipeIngredient).toContain("400 g spaghetti");
  expect(jsonLd.recipeIngredient).not.toContain("2 lemons");
});

test("omission survives an unrelated edit (stable ingredient ids)", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await createPasta(page);
  await addToDraft(page);

  // The omit toggle is an optimistic-UI fetcher: the "Include lemons"
  // label flips immediately while the POST and its loader revalidation
  // are still in flight. Clicking the "Edit recipe" <Link> during that
  // revalidation makes React Router occasionally drop the navigation
  // (~20% flake). Await the revalidation GET so the router has left its
  // loading state before we navigate away.
  const revalidated = page.waitForResponse(
    (res) =>
      res.request().method() === "GET" &&
      /\/recipes\/[0-9a-f-]{36}\.data/.test(res.url()),
  );
  await page.getByRole("button", { name: "Omit lemons" }).click();
  await expect(
    page.getByRole("button", { name: "Include lemons" }),
  ).toBeVisible();
  await revalidated;

  // Edit an unrelated field (the name) and save.
  await page.getByRole("link", { name: "Edit recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}\/edit$/);
  await page.getByLabel("Name").fill("Pasta al limone (better)");
  await expect(page.getByLabel("Name")).toHaveValue("Pasta al limone (better)");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);

  // The omission is still in effect after the edit.
  await expect(
    page.getByRole("button", { name: "Include lemons" }),
  ).toBeVisible();
  await expect(page.getByText("2 lemons")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
});
