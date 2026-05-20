import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { getLocal, generateCACertificate, type Mockttp } from "mockttp";
import { login } from "./login";
import { KPTNCOOK_TEST_API_KEY } from "./proxy/fixtures";

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

export type MockttpHandle = {
  /** Running mockttp server (HTTPS, MITM-ing via generated CA). */
  server: Mockttp;
  /** Env block to merge into a child process that should route through this proxy. */
  proxyEnv: NodeJS.ProcessEnv;
  /** Path to the generated CA cert (also referenced by proxyEnv). */
  caCertPath: string;
};

export type ServerHandle = {
  /** Base URL of this worker's netlify-dev instance. */
  baseURL: string;
};

export type WorkerFixtures = {
  mockttp: MockttpHandle;
  server: ServerHandle;
};

export type TestFixtures = {
  flat: Flat;
  /**
   * Opt-in handle to the worker's mockttp proxy. Asking for this
   * fixture means: "I will register some mocks." The fixture resets
   * the proxy on teardown and re-installs the default
   * unmatched-passthrough rule, so the next test starts clean. Tests
   * that don't list `httpMocks` in their args neither reset nor incur
   * any per-test proxy cost.
   *
   * Named `httpMocks` rather than `proxy` to avoid colliding with
   * Playwright's built-in `proxy` browser-context option.
   */
  httpMocks: Mockttp;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // ---------------------------------------------------------------
  // Worker-scoped: one mockttp proxy per worker.
  mockttp: [
    async ({}, use) => {
      const ca = await generateCACertificate();
      const dir = await mkdtemp(join(tmpdir(), "cookbook-proxy-ca-"));
      const caCertPath = join(dir, "ca.pem");
      await writeFile(caCertPath, ca.cert);

      const server = getLocal({
        https: { cert: ca.cert, key: ca.key },
        // Flip to true when debugging a proxy miss.
        debug: false,
      });
      await server.start();
      await installPassthroughDefault(server);

      const proxyEnv: NodeJS.ProcessEnv = {
        ...server.proxyEnv,
        NODE_USE_ENV_PROXY: "1",
        NODE_EXTRA_CA_CERTS: caCertPath,
      };

      await use({ server, proxyEnv, caCertPath });

      await server.stop();
      await rm(dir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],

  // ---------------------------------------------------------------
  // Worker-scoped: one `netlify dev` per worker, wired to mockttp.
  server: [
    async ({ mockttp }, use, workerInfo) => {
      // `netlify dev --port 0` makes the CLI pick a free port itself
      // (the underlying `get-port` lib starts from a random high port
      // and walks until it finds something free). We parse the actual
      // bound port out of stdout — "Local dev server ready:
      // http://localhost:NNNNN".
      const child = spawn(
        "npx",
        ["netlify", "dev", "--port", "0", "--no-open"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          // Put the child in its own process group so we can kill the
          // whole tree on teardown — npx → netlify → react-router dev
          // → vite are otherwise easy to leak.
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
            // Route all outbound HTTP(S) through this worker's
            // mockttp proxy and trust its CA. Without these the app
            // would hit the real internet.
            ...mockttp.proxyEnv,
          },
        },
      );

      const baseURLPromise = readyURLFromStdout(child, 180_000);

      const exited = new Promise<never>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(
              `netlify dev (worker ${workerInfo.parallelIndex}) exited unexpectedly (code=${code} signal=${signal})`,
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
  // this worker's netlify-dev automatically. The value is identical
  // for every test in a worker because `server` is worker-scoped.
  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },

  // ---------------------------------------------------------------
  // Test-scoped, opt-in: hand the worker mockttp to the spec, then
  // reset it on teardown. Specs that don't list `httpMocks` don't
  // trigger any reset work.
  httpMocks: async ({ mockttp }, use) => {
    await use(mockttp.server);
    await mockttp.server.reset();
    await installPassthroughDefault(mockttp.server);
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
 * Default policy for the worker mockttp: anything we didn't
 * explicitly mock is passed through to the real network. This keeps
 * the Netlify CLI's own backend chatter (api.netlify.com, CDN
 * downloads for edge-function runtimes, etc.) working transparently —
 * that traffic isn't from app code and we don't want to mock it.
 *
 * Trade-off: if app code grows a new external integration and the
 * spec forgets to mock it, the test will silently hit the real
 * upstream instead of failing fast. Mitigation: keep the list of
 * external upstreams reviewed.
 */
async function installPassthroughDefault(server: Mockttp) {
  await server.forUnmatchedRequest().thenPassThrough({
    beforeRequest: (req) => {
      if (process.env.PROXY_LOG_UNMATCHED === "1") {
        console.log(`[proxy] passthrough ${req.method} ${req.url}`);
      }
    },
  });
}

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
    const re = /Local dev server ready:\s+(https?:\/\/[^\s│]+)/;
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timed out waiting for netlify dev ready line. Last stdout:\n${buffer.slice(-2000)}`,
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
