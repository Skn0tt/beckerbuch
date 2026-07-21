import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import { login } from "./login";

test("nav progress appears while a slow navigation is in flight", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  // React Router client navigations hit `<route>.data` (see draft.spec.ts).
  await page.route("**/flat/settings.data*", async (route) => {
    await held;
    await route.continue();
  });

  const click = page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("nav-progress")).toBeVisible({
    timeout: 5_000,
  });
  release();
  await click;
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(page.getByTestId("nav-progress")).toHaveCount(0);
});

test("prerendered index.html contains workspace skeletons", () => {
  const html = readFileSync(
    path.join(process.cwd(), "build/client/index.html"),
    "utf8",
  );
  expect(html).toContain("Loading recipes");
  expect(html).toContain("Loading kitchen");
});
