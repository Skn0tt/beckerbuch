import { expect, test } from "./fixtures";
import { login } from "./login";
import type { Page } from "@playwright/test";
import { geminiEmbeddingHandler } from "./mock-handlers";

test.beforeEach(async ({ mocks }) => {
  await mocks.route(
    "https://generativelanguage.googleapis.com/**",
    geminiEmbeddingHandler(),
  );
});

test.describe("PWA install (manifest + apple meta)", () => {
  test("serves manifest.webmanifest with standalone display", async ({
    request,
  }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);
    const manifest = (await res.json()) as {
      name: string;
      start_url: string;
      display: string;
    };
    expect(manifest.name).toBe("beckerbuch");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  test("document head links the manifest and enables home-screen install", async ({
    page,
  }) => {
    // The manifest link + apple meta live in the root document, so any route
    // renders them — /login needs no auth.
    await page.goto("/login");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
    await expect(
      page.locator('meta[name="apple-mobile-web-app-capable"]'),
    ).toHaveAttribute("content", "yes");
    await expect(
      page.locator('meta[name="mobile-web-app-capable"]'),
    ).toHaveAttribute("content", "yes");
  });
});

test.describe("Header back button", () => {
  test("hidden on the top-level collection, shown on sub-routes and navigates back", async ({
    page,
    flat,
  }) => {
    await login(page, flat.user);

    // On the top-level Recipes route there is nowhere to go back to.
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);

    // Navigate into a sub-route (flat settings) — back button appears.
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL("/flat/settings");
    const back = page.getByRole("button", { name: "Back" });
    await expect(back).toBeVisible();

    // The back slot is always reserved, so revealing the button must not
    // shift the flat-name heading horizontally.
    const xWithBack = (await page.getByTestId("flat-name").boundingBox())?.x;

    // Clicking it returns to the previous page.
    await back.click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    const xWithoutBack = (await page.getByTestId("flat-name").boundingBox())?.x;

    expect(xWithBack).toBeDefined();
    expect(xWithoutBack).toBeDefined();
    expect(Math.abs((xWithBack ?? 0) - (xWithoutBack ?? 0))).toBeLessThan(1);
  });
});

async function createRecipeAndAddToDraft(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "+ New recipe" }).click();
  await page.getByLabel("Name").fill(name);
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
  await page.getByRole("button", { name: "+ Add to draft" }).click();
  await expect(page.getByRole("button", { name: "✓ In draft" })).toBeVisible();
}

test.describe("Send to Bring! (navigator.share)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shares the handoff URL via the OS share sheet", async ({
    page,
    flat,
  }) => {
    // Stub navigator.share before any page script runs so the client
    // feature-detect sees it and renders the button.
    await page.addInitScript(() => {
      (window as unknown as { __shareCalls: unknown[] }).__shareCalls = [];
      Object.defineProperty(navigator, "share", {
        configurable: true,
        writable: true,
        value: (data: unknown) => {
          (window as unknown as { __shareCalls: unknown[] }).__shareCalls.push(
            data,
          );
          return Promise.resolve();
        },
      });
    });

    await login(page, flat.user);
    await createRecipeAndAddToDraft(page, "Pasta al limone");

    await page.goto("/kitchen");
    await page.getByRole("button", { name: "Finalise draft" }).click();
    await page.getByRole("button", { name: "Confirm finalise draft" }).click();
    await expect(page).toHaveURL(`/h/${flat.id}`);

    const shareButton = page.getByTestId("share-to-bring");
    await expect(shareButton).toBeVisible();
    await shareButton.click();

    const calls = await page.evaluate(
      () => (window as unknown as { __shareCalls: { url?: string }[] }).__shareCalls,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(new RegExp(`/h/${flat.id}$`));
  });
});
