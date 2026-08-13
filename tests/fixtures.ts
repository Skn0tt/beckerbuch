import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import {
  test as base,
  expect,
  mergeTests,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { login } from "./login";
import { KPTNCOOK_TEST_API_KEY } from "./mock-data";
import { BRING_WIDGET_STUB } from "./bring-widget-stub";
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
  /** Base URL of this worker's react-router-serve process. */
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
  // Browser-side: stub Bring!'s import.js so every spec that hits /h/:flatId
  // stays off the real CDN (the Node mock proxy only sees the app server).
  context: async ({ context }, use) => {
    await installBringWidgetMock(context);
    await use(context);
  },

  // ---------------------------------------------------------------
  // Worker-scoped: one `react-router-serve` process per worker,
  // wired to the proxy, running the production build that
  // global-setup produced. We deliberately don't use Vite here —
  // tests then exercise the exact bundle Netlify deploys, and we
  // sidestep the typegen-on-boot race that fires when multiple
  // Vite workers rebuild `.react-router/types` in parallel.
  //
  // Netlify primitive emulation (Blobs — recipe photos round-trip
  // through it) is provided by a per-worker BlobsServer below;
  // see the `NETLIFY_BLOBS_CONTEXT` env var.
  server: [
    async ({ workerProxy }, use, workerInfo) => {
      const port = await findFreePort();

      // Spin up a per-worker Netlify Blobs server so `@netlify/blobs`
      // calls in the app (recipe photos, avatars) hit a local store
      // instead of trying to reach production. Mirrors what
      // `@netlify/dev` does when wiring up Netlify primitives — see
      // node_modules/@netlify/dev/dist/main.js getRuntime() — but
      // standalone so we don't need `netlify dev` (which clobbers
      // OPENAI_API_KEY and injects an AI-Gateway base URL behind
      // our backs).
      //
      // Lives under the project's Playwright output dir so it's
      // inspectable after a failure and gets cleaned up on the next
      // run alongside the rest of test-results/.
      const blobsDir = path.join(
        workerInfo.project.outputDir,
        `.netlify-blobs-worker-${workerInfo.parallelIndex}`,
      );
      await mkdir(blobsDir, { recursive: true });
      const blobsToken = randomUUID();
      const blobs = new BlobsServer({ directory: blobsDir, token: blobsToken });
      const blobsDetails = await blobs.start();
      const blobsEdgeURL = `http://localhost:${blobsDetails.port}`;
      const blobsContext = Buffer.from(
        JSON.stringify({
          deployID: `cookbook-test-deploy-${workerInfo.parallelIndex}`,
          edgeURL: blobsEdgeURL,
          primaryRegion: "us-east-2",
          siteID: `cookbook-test-site-${workerInfo.parallelIndex}`,
          token: blobsToken,
          uncachedEdgeURL: blobsEdgeURL,
        }),
        "utf8",
      ).toString("base64");

      const child = spawn(
        "npx",
        ["react-router-serve", "build/server/server-build.js"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group so we can kill the whole tree on
          // teardown.
          detached: true,
          env: {
            ...process.env,
            PORT: String(port),
            // globalSetup writes DATABASE_URL into process.env.
            DATABASE_URL: process.env.DATABASE_URL,
            // Match what Netlify runs in production. The bin script
            // also defaults to "production" when unset, but we set
            // it explicitly so React picks the prod bundle here too.
            NODE_ENV: "production",
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
            // `@netlify/blobs` reads this to route store ops to the
            // local BlobsServer above.
            NETLIFY_BLOBS_CONTEXT: blobsContext,
            // Route all outbound HTTP(S) through this worker's proxy
            // and trust its CA. Without these the app would hit the
            // real internet.
            ...workerProxy.env,
          },
        },
      );

      const baseURLPromise = readyURLFromStdout(child, 60_000);

      const exited = new Promise<never>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `react-router-serve (worker ${workerInfo.parallelIndex}) exited unexpectedly (code=${code} signal=${signal})`,
            ),
          );
        });
      });

      let baseURL: string;
      try {
        baseURL = await Promise.race([baseURLPromise, exited]);
      } catch (err) {
        killTree(child);
        await blobs.stop().catch(() => undefined);
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
      await blobs.stop().catch(() => undefined);
      // Don't `rm` blobsDir — it sits under workerInfo.outputDir, so
      // Playwright handles cleanup on the next run and the contents
      // stay around for post-mortem inspection.
    },
    { scope: "worker", timeout: 180_000 },
  ],

  // Override Playwright's built-in `baseURL` (test scope, since
  // Playwright defines it that way) so `page` and `request` route to
  // this worker's react-router-serve process automatically. The value
  // is identical for every test in a worker because `server` is
  // worker-scoped.
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
 * Intercept Bring! widget + related CDN requests on a Playwright context.
 * The default `context` fixture already calls this; extra contexts created
 * via `browser.newContext()` need it too if they load `/h/:flatId`.
 */
export async function installBringWidgetMock(context: BrowserContext) {
  await context.route("**://platform.getbring.com/**", async (route) => {
    if (route.request().url().includes("import.js")) {
      await route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: BRING_WIDGET_STUB,
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}

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
    // react-router-serve prints:
    //   "[react-router-serve] http://localhost:NNNN (http://…)"
    const re = /\[react-router-serve\]\s+(https?:\/\/\S+)/m;
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timed out waiting for react-router-serve ready line. Last stdout:\n${buffer.slice(-2000)}`,
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

/**
 * Ask the kernel for a free TCP port by binding to port 0, reading
 * the assigned port, and closing immediately. Has a TOCTOU race with
 * anything else that grabs the port between close and the next bind,
 * but in practice the window is microseconds and Playwright workers
 * don't fight over the same port pool.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not read assigned port")));
      }
    });
  });
}
