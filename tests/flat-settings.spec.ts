import { test, expect, generateInvite } from "./fixtures";
import { login } from "./login";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

test("settings shows flat name, current user as member, and a generate button", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await page.getByRole("link", { name: "Settings" }).click();

  await expect(page).toHaveURL("/flat/settings");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  const memberRow = page.getByRole("listitem").filter({ hasText: flat.user.email });
  await expect(memberRow.getByText(flat.user.displayName)).toBeVisible();
  await expect(memberRow.getByText(flat.user.email)).toBeVisible();
  await expect(page.getByRole("button", { name: /generate/i })).toBeVisible();
});

test("generate link creates an invite that works", async ({ page, flat }) => {
  const url = await generateInvite(page, flat.user);
  expect(url).toContain("/invite/");

  // Visit the generated invite URL in a fresh context — it should show the
  // signup form, not 404.
  const fresh = await page.context().browser()!.newContext();
  const freshPage = await fresh.newPage();
  await freshPage.goto(url);
  await expect(
    freshPage.getByRole("heading", { name: `Join ${flat.name}` }),
  ).toBeVisible();
  await fresh.close();
});

test("generate new link rotates the previous one", async ({ page, flat }) => {
  const oldUrl = await generateInvite(page, flat.user);

  // Click Generate again — rotates to a fresh token.
  await page.getByRole("button", { name: /generate/i }).click();
  await expect
    .poll(() => page.getByLabel("Invite link").inputValue())
    .not.toBe(oldUrl);

  // Old URL now 404s.
  const fresh = await page.context().browser()!.newContext();
  const freshPage = await fresh.newPage();
  const res = await freshPage.goto(oldUrl);
  expect(res?.status()).toBe(404);
  await fresh.close();
});

test("anonymous visit redirects to /login", async ({ page }) => {
  await page.goto("/flat/settings");
  await expect(page).toHaveURL(/\/login\?redirect=/);
});

test("settings shows the MCP URL with a copy button and a link to Claude docs", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await page.goto("/flat/settings");

  const mcpInput = page.getByLabel("MCP URL");
  await expect(mcpInput).toBeVisible();
  const value = await mcpInput.inputValue();
  expect(value).toMatch(/\/mcp$/);
  expect(new URL(value).pathname).toBe("/mcp");

  // Copy button sits next to the input; assert one is reachable from the
  // same Paper as the MCP input.
  await expect(
    page.getByRole("button", { name: /^copy$/i }).last(),
  ).toBeVisible();

  const claudeLink = page.getByRole("link", { name: "Claude" });
  await expect(claudeLink).toHaveAttribute(
    "href",
    "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  );
  await expect(claudeLink).toHaveAttribute("target", "_blank");
});

test("clicking avatar opens picker and uploads profile picture", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await page.goto("/flat/settings");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Change profile picture" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });

  await expect(
    page.getByRole("img", { name: flat.user.displayName }).first(),
  ).toBeVisible();
});

test("display name is editable inline on settings", async ({ page, flat }) => {
  await login(page, flat.user);
  await page.goto("/flat/settings");

  const nextName = `${flat.user.displayName} Updated`;
  await page.getByRole("button", { name: flat.user.displayName }).click();
  const input = page.getByRole("textbox", { name: "Display name" });
  await expect(input).toBeFocused();
  await input.fill(nextName);
  await input.press("Enter");

  await expect(page.getByTestId("current-user")).toHaveText(nextName);
  await expect(
    page.getByRole("listitem").filter({ hasText: flat.user.email }).getByText(nextName),
  ).toBeVisible();
});
