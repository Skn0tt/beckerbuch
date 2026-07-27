import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
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
import {
  listV8CoverageFiles,
  writeCoverageArtifacts,
  type PlaywrightJSCoverageEntry,
} from "./coverage-remap";

const ADMIN_TOKEN = "test-admin-token";

// A long, NIST-friendly password reused by every provisioned test user.
const TEST_PASSWORD = "cookbook-test-password";

const require = createRequire(import.meta.url);
const REACT_ROUTER_SERVE_BIN = path.join(
  path.dirname(require.resolve("@react-router/serve/package.json")),
  "bin.js",
);
const COVERAGE_PRELOAD = path.resolve("tests/server-coverage-preload.mjs");
const COVERAGE_ACK = "__COVERAGE_DUMPED__";
const COVERAGE_FAIL = "__COVERAGE_DUMP_FAILED__";

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
  /** Pid of the node process (for SIGUSR2 coverage dumps). */
  pid: number;
  /** Per-worker NODE_V8_COVERAGE directory. */
  v8CoverageDir: string;
  /** Dump + discard V8 coverage so the next interval starts clean. */
  resetCoverage: () => Promise<void>;
  /** Dump V8 coverage since the last reset; returns new JSON file paths. */
  dumpCoverage: () => Promise<string[]>;
};

export type AppWorkerFixtures = {
  server: ServerHandle;
};

export type AppTestFixtures = {
  flat: Flat;
  /** Ensures invite-flow page work sits inside the coverage window. */
  _coverage: void;
};

export type WorkerFixtures = AppWorkerFixtures & MocksWorkerFixtures;
export type TestFixtures = AppTestFixtures & MocksTestFixtures;

const appTest = base.extend<AppTestFixtures, AppWorkerFixtures & MocksWorkerFixtures>({
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

      const v8CoverageDir = path.join(
        workerInfo.project.outputDir,
        `.v8-coverage-worker-${workerInfo.parallelIndex}`,
      );
      await mkdir(v8CoverageDir, { recursive: true });
      // Clear leftover dumps from a previous crashed run.
      for (const file of await listV8CoverageFiles(v8CoverageDir)) {
        await rm(file, { force: true }).catch(() => undefined);
      }

      // Spawn node directly (not npx) so SIGUSR2 hits the process that
      // loaded the coverage preload — npx would be an intermediate.
      const child = spawn(
        process.execPath,
        [
          "--import",
          COVERAGE_PRELOAD,
          REACT_ROUTER_SERVE_BIN,
          "build/server/server-build.js",
        ],
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
            // Per-worker V8 coverage output; dumped on SIGUSR2 via preload.
            NODE_V8_COVERAGE: v8CoverageDir,
            // Route all outbound HTTP(S) through this worker's proxy
            // and trust its CA. Without these the app would hit the
            // real internet.
            ...workerProxy.env,
          },
        },
      );

      if (child.pid === undefined) {
        await blobs.stop().catch(() => undefined);
        throw new Error("failed to spawn react-router-serve (no pid)");
      }

      const stdout = attachChildStdout(child);

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
        baseURL = await Promise.race([stdout.waitReadyURL(60_000), exited]);
      } catch (err) {
        killTree(child);
        await blobs.stop().catch(() => undefined);
        throw err;
      }

      const pid = child.pid;

      const signalCoverageDump = async (): Promise<string[]> => {
        const before = new Set(await listV8CoverageFiles(v8CoverageDir));
        // Drop any leftover ACK/FAIL tokens before arming the waiter so
        // a previous timed-out dump can't satisfy this wait.
        stdout.discardPendingCoverageSignals();
        const ack = stdout.waitCoverageAck(10_000);
        try {
          process.kill(pid, "SIGUSR2");
        } catch (err) {
          throw new Error(`SIGUSR2 failed for pid ${pid}: ${String(err)}`);
        }
        await ack;
        const after = await listV8CoverageFiles(v8CoverageDir);
        return after.filter((f) => !before.has(f));
      };

      const handle: ServerHandle = {
        baseURL,
        pid,
        v8CoverageDir,
        resetCoverage: async () => {
          const files = await signalCoverageDump();
          for (const file of files) {
            await rm(file, { force: true }).catch(() => undefined);
          }
          // Also wipe any stragglers so the interval is empty.
          for (const file of await listV8CoverageFiles(v8CoverageDir)) {
            await rm(file, { force: true }).catch(() => undefined);
          }
        },
        dumpCoverage: async () => signalCoverageDump(),
      };

      await use(handle);

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
   * Always-on coverage: reset Node V8, start Playwright JSCoverage,
   * run the test (including `flat` setup), then dump/remap/merge FE+BE
   * into test-results/coverage/<worker>-<testId>/coverage.json.
   */
  _coverage: [
    async ({ page, server }, use, testInfo) => {
      // Setup must succeed — a failed reset would attribute the previous
      // test's server work to this one.
      await server.resetCoverage();
      await page.coverage.startJSCoverage({ resetOnNavigation: false });

      await use();

      // Teardown: collect best-effort so a remap glitch doesn't fail the
      // test after assertions already passed. Annotate when we drop data.
      let frontendEntries: PlaywrightJSCoverageEntry[] = [];
      let backendFiles: string[] = [];
      try {
        frontendEntries =
          (await page.coverage.stopJSCoverage()) as PlaywrightJSCoverageEntry[];
      } catch (err) {
        console.error("[coverage] stopJSCoverage failed:", err);
        testInfo.annotations.push({
          type: "coverage",
          description: `stopJSCoverage failed: ${String(err)}`,
        });
      }

      try {
        backendFiles = await server.dumpCoverage();
      } catch (err) {
        console.error("[coverage] dumpCoverage failed:", err);
        testInfo.annotations.push({
          type: "coverage",
          description: `dumpCoverage failed: ${String(err)}`,
        });
      }

      try {
        await writeCoverageArtifacts({
          testInfo,
          frontendEntries,
          backendFiles,
        });
      } catch (err) {
        console.error("[coverage] remap/write failed:", err);
        testInfo.annotations.push({
          type: "coverage",
          description: `remap/write failed: ${String(err)}`,
        });
      }

      for (const file of backendFiles) {
        await rm(file, { force: true }).catch(() => undefined);
      }
      for (const file of await listV8CoverageFiles(server.v8CoverageDir)) {
        await rm(file, { force: true }).catch(() => undefined);
      }
    },
    { auto: true },
  ],

  /**
   * Provision a fresh flat plus a real first user. Talks to the admin
   * endpoint via Playwright's `request` fixture (so it shares the test
   * runner's HTTP plumbing), then drives the public invite-redemption
   * form via `page` — the same path a real founder would walk.
   *
   * After redemption the page would be logged in as the new user, but
   * we clear cookies so each test decides for itself when (and as
   * whom) to log in.
   *
   * Depends on `_coverage` so the invite UI work is inside the
   * JSCoverage window started by the auto coverage fixture.
   */
  flat: async ({ request, page, _coverage: _ }, use) => {
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
function killTree(child: ChildProcess) {
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

type ChildStdout = {
  waitReadyURL: (timeoutMs: number) => Promise<string>;
  waitCoverageAck: (timeoutMs: number) => Promise<void>;
  /** Strip buffered ACK/FAIL tokens so a later wait can't consume them. */
  discardPendingCoverageSignals: () => void;
};

/**
 * Single stdout/stderr consumer for the server child: echoes output,
 * resolves the react-router-serve ready URL once, and multiplexes
 * coverage-dump ack waits for SIGUSR2.
 */
function attachChildStdout(child: ChildProcess): ChildStdout {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout) {
    throw new Error("child has no stdout pipe");
  }

  let buffer = "";
  let readyURL: string | undefined;
  const readyWaiters: Array<{
    resolve: (url: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  const ackWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  // react-router-serve prints:
  //   "[react-router-serve] http://localhost:NNNN (http://…)"
  const readyRe = /\[react-router-serve\]\s+(https?:\/\/\S+)/m;
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/g;

  const stripToken = (token: string): boolean => {
    const rawIdx = buffer.indexOf(token);
    if (rawIdx === -1) return false;
    buffer = buffer.slice(0, rawIdx) + buffer.slice(rawIdx + token.length);
    return true;
  };

  const discardPendingCoverageSignals = () => {
    while (stripToken(COVERAGE_ACK) || stripToken(COVERAGE_FAIL)) {
      // keep stripping
    }
  };

  const onChunk = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    process.stdout.write(text);
    buffer += text;

    if (!readyURL) {
      const clean = buffer.replace(ansi, "");
      const m = clean.match(readyRe);
      if (m) {
        readyURL = m[1].replace(/[\s.,;]+$/, "");
        for (const w of readyWaiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve(readyURL);
        }
      }
    }

    // Deliver at most one signal per waiter. Always strip unmatched
    // tokens so they can't satisfy a future wait (stale ACK after timeout).
    while (ackWaiters.length > 0) {
      const hasAck = buffer.includes(COVERAGE_ACK);
      const hasFail = buffer.includes(COVERAGE_FAIL);
      if (!hasAck && !hasFail) break;
      // Prefer whichever token appears first in the buffer.
      const ackAt = hasAck ? buffer.indexOf(COVERAGE_ACK) : Infinity;
      const failAt = hasFail ? buffer.indexOf(COVERAGE_FAIL) : Infinity;
      const w = ackWaiters.shift();
      if (!w) break;
      clearTimeout(w.timer);
      if (failAt < ackAt) {
        stripToken(COVERAGE_FAIL);
        w.reject(new Error("server reported coverage dump failure"));
      } else {
        stripToken(COVERAGE_ACK);
        w.resolve();
      }
    }
    // No waiter yet — drop signals so they can't race the next wait.
    if (ackWaiters.length === 0) {
      discardPendingCoverageSignals();
    }

    if (buffer.length > 64 * 1024) buffer = buffer.slice(-32 * 1024);
  };

  stdout.on("data", onChunk);
  if (stderr) stderr.on("data", onChunk);

  return {
    waitReadyURL(timeoutMs) {
      if (readyURL) return Promise.resolve(readyURL);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = readyWaiters.findIndex((w) => w.timer === timer);
          if (i >= 0) readyWaiters.splice(i, 1);
          reject(
            new Error(
              `Timed out waiting for react-router-serve ready line. Last stdout:\n${buffer.slice(-2000)}`,
            ),
          );
        }, timeoutMs);
        readyWaiters.push({ resolve, reject, timer });
      });
    },
    waitCoverageAck(timeoutMs) {
      // Intentionally does NOT resolve on already-buffered tokens —
      // callers must discardPendingCoverageSignals() then signal, so
      // only the ACK from *this* SIGUSR2 counts.
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = ackWaiters.findIndex((w) => w.timer === timer);
          if (i >= 0) ackWaiters.splice(i, 1);
          reject(
            new Error(
              `Timed out waiting for ${COVERAGE_ACK}. Last stdout:\n${buffer.slice(-2000)}`,
            ),
          );
        }, timeoutMs);
        ackWaiters.push({ resolve, reject, timer });
      });
    },
    discardPendingCoverageSignals,
  };
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
