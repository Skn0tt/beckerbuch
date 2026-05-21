import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  test as base,
  expect,
  mergeTests,
  type Page,
} from "@playwright/test";
import { login } from "./login";
import { KPTNCOOK_TEST_API_KEY } from "./mock-data";
import {
  test as mocksTest,
  type MocksTestFixtures,
  type MocksWorkerFixtures,
} from "./playwright-mocks/src";

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

export type ServerHandle = {
  /** Base URL of this worker's vite dev server. */
  baseURL: string;
};

export type AppWorkerFixtures = {
  server: ServerHandle;
};

export type AppTestFixtures = {
  flat: Flat;
};

export type WorkerFixtures = AppWorkerFixtures & MocksWorkerFixtures;
export type TestFixtures = AppTestFixtures & MocksTestFixtures;

const appTest = base.extend<AppTestFixtures, AppWorkerFixtures & MocksWorkerFixtures>({
  // ---------------------------------------------------------------
  // Worker-scoped: one Vite dev server per worker, wired to the proxy.
  // We rely on `@netlify/vite-plugin` for Netlify primitive emulation
  // (Blobs is the one we actually use — recipe photos round-trip
  // through it). Vite is much faster to boot than `netlify dev`, and
  // unlike the CLI it doesn't clobber OPENAI_API_KEY or inject an
  // AI-Gateway base URL behind our backs.
  server: [
    async ({ workerProxy }, use, workerInfo) => {
      // Vite walks ports starting from `server.port` (default 5173)
      // when the requested one is busy, so we don't need to allocate
      // ourselves; the actual bound URL is parsed out of stdout.
      const child = spawn("npx", ["vite"], {
        stdio: ["ignore", "pipe", "pipe"],
        // Put the child in its own process group so we can kill the
        // whole tree on teardown — npx → vite (→ worker threads,
        // optimizer subprocesses) are otherwise easy to leak.
        detached: true,
        env: {
          ...process.env,
          // globalSetup writes DATABASE_URL into process.env.
          DATABASE_URL: process.env.DATABASE_URL,
          NODE_ENV: process.env.NODE_ENV ?? "test",
          SESSION_SECRET:
            process.env.SESSION_SECRET ??
            "test-only-not-a-secret-but-long-enough",
          ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? ADMIN_TOKEN,
          // kptncook still wants an API key — the mock helper
          // checks for this exact value and rejects anything else.
          KPTNCOOK_API_KEY: process.env.KPTNCOOK_API_KEY ?? KPTNCOOK_TEST_API_KEY,
          // The OpenAI SDK refuses to construct without an API
          // key. The mock helper accepts any value.
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-openai-key",
          // Route all outbound HTTP(S) through this worker's proxy
          // and trust its CA. Without these the app would hit the
          // real internet.
          ...workerProxy.env,
        },
      });

      const baseURLPromise = readyURLFromStdout(child, 180_000);

      const exited = new Promise<never>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `vite (worker ${workerInfo.parallelIndex}) exited unexpectedly (code=${code} signal=${signal})`,
            ),
          );
        });
      });

      let baseURL: string;
      try {
        baseURL = await Promise.race([baseURLPromise, exited]);
      } catch (err) {
        killTree(child);
        throw err;
      }

      await use({ baseURL });

      killTree(child);
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
    },
    { scope: "worker", timeout: 180_000 },
  ],

  // Override Playwright's built-in `baseURL` (test scope, since
  // Playwright defines it that way) so `page` and `request` route to
  // this worker's vite dev server automatically. The value is identical
  // for every test in a worker because `server` is worker-scoped.
  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },

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

// Compose the proxy fixtures (workerProxy + mocks) from the library
// with this app's fixtures. `server` depends on `workerProxy` across
// the merge — Playwright resolves cross-fixture deps because both
// extensions chain off the same `base`.
export const test = mergeTests(mocksTest, appTest);

export { expect };

/**
 * Drive the flat-settings UI to mint a fresh invite link as `user`. The
 * page is left logged in and on `/flat/settings`; callers that want to
 * redeem the invite anonymously should `clearCookies()` afterwards.
 */
export async function generateInvite(page: Page, user: TestUser): Promise<string> {
  await login(page, user);
  await page.goto("/flat/settings");
  await page.getByRole("button", { name: /generate/i }).click();
  await expect(page.getByLabel("Invite link")).toBeVisible();
  return page.getByLabel("Invite link").inputValue();
}

// --------------------------------------------------------------------
// helpers

/**
 * Kill a child and everything in its process group. With
 * `detached: true` at spawn, the child becomes the leader of its own
 * process group, so we can SIGTERM the whole tree by signalling -pid.
 */
function killTree(child: import("node:child_process").ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Group might already be gone — fall back to the direct child.
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

function readyURLFromStdout(
  child: import("node:child_process").ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout) {
      reject(new Error("child has no stdout pipe"));
      return;
    }
    let buffer = "";
    let settled = false;
    // Vite prints: "  ➜  Local:   http://localhost:NNNN/"
    const re = /Local:\s+(https?:\/\/\S+?)\/?\s*$/m;
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timed out waiting for vite ready line. Last stdout:\n${buffer.slice(-2000)}`,
        ),
      );
    }, timeoutMs);
    const onChunk = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      process.stdout.write(text);
      if (settled) return;
      buffer += text;
      const m = buffer.replace(ansi, "").match(re);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolve(m[1].replace(/[\s.,;]+$/, ""));
      }
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-32 * 1024);
    };
    stdout.on("data", onChunk);
    if (stderr) stderr.on("data", onChunk);
  });
}
