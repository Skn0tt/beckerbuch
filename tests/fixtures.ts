import { randomUUID } from "node:crypto";
import { test as base, type Page } from "@playwright/test";
import { login } from "./login";

const ADMIN_TOKEN = "test-admin-token";

// A long, NIST-friendly password reused by every provisioned test user.
const TEST_PASSWORD = "cookbook-test-password";

export type TestUser = {
  email: string;
  password: string;
  displayName: string;
};

export type Flat = {
  id: string;
  name: string;
  user: TestUser;
};

export type Fixtures = {
  flat: Flat;
};

export const test = base.extend<Fixtures>({
  /**
   * Provision a fresh flat plus a real first user. Talks to the admin
   * endpoint via Playwright's `request` fixture (so it shares the test
   * runner's HTTP plumbing), then drives the public invite-redemption
   * form via `page` — the same path a real founder would walk.
   *
   * After redemption the page would be logged in as the new user, but
   * we clear cookies so each test decides for itself when (and as
   * whom) to log in.
   */
  flat: async ({ request, page }, use) => {
    const slug = randomUUID();

    const res = await request.post("/admin/tenants", {
      data: {},
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    if (!res.ok()) {
      throw new Error(`POST /admin/tenants failed (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as {
      flat: { id: string; name: string };
      inviteUrl: string;
    };

    const user: TestUser = {
      email: `test-${slug}@cookbook.test`,
      password: TEST_PASSWORD,
      displayName: `Test Cook ${slug.slice(0, 8)}`,
    };

    await page.goto(body.inviteUrl);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Display name").fill(user.displayName);
    await page.getByRole("textbox", { name: "Password" }).fill(user.password);
    await page.getByRole("button", { name: "Create account & join" }).click();
    await page.waitForURL("/");
    await page.context().clearCookies();

    await use({ id: body.flat.id, name: body.flat.name, user });
  },
});

export { expect } from "@playwright/test";

/**
 * Drive the flat-settings UI to mint a fresh invite link as `user`. The
 * page is left logged in and on `/flat/settings`; callers that want to
 * redeem the invite anonymously should `clearCookies()` afterwards.
 */
export async function generateInvite(page: Page, user: TestUser): Promise<string> {
  await login(page, user);
  await page.goto("/flat/settings");
  await page.getByRole("button", { name: /generate/i }).click();
  await page.waitForURL("/flat/settings");
  return page.getByLabel("Invite link").inputValue();
}
