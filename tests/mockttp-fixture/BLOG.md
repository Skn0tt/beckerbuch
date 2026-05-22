# Mocking Server Side HTTP in Playwright with mockttp

I've been building a little recipe app for my household, and along
the way I needed to mock out third-party APIs in my Playwright tests.
This works wonderfully for browser requests with `page.route()`, but not for server-side HTTP calls.
Initially I had mock-only branches mixed into server code, but that got complicated quickly — especially with multiple APIs, and when the same API needed to be mocked differently in different tests.
I landed on a setup around an HTTP proxy that intercepts and mocks outgoing traffic from the server,
configured from the test code.

## The Idea

Instead of patching modules or adding a `process.env.TEST` branch, we mock at the **network boundary**.
Our app makes the same HTTPS calls it always makes; a forward proxy sits in front and decides
whether to answer with a canned response or pass the request through.
What makes this work is the `HTTP_PROXY`/`HTTPS_PROXY` env var convention — a de-facto standard
that almost every HTTP client honours.

I use the [**mockttp**](https://github.com/httptoolkit/mockttp) library as the proxy. It:

*   🔐 Generates a CA on the fly
*   🌐 Runs an HTTP / HTTPS forward proxy in-process
*   🧱 Provides a fluent rule builder for mocks

It is started once per Playwright worker, and every test can configure it to its liking.

> The snippets below show a Node dev server, but **none of this is
> Node-specific** — any language whose HTTP client respects
> `HTTP_PROXY`/`HTTPS_PROXY` works the same way (Python, Go, Ruby,
> Rust, .NET; Java needs `-Dhttps.proxyHost`/`-Dhttps.proxyPort`
> instead of env vars). You'll need to teach each runtime to
> trust mockttp's auto-generated CA — `SSL_CERT_FILE` for Python
> and Ruby, `SSL_CERT_DIR` for Go, and so on.

## Setting Up the Fixture

We're setting up mockttp as a [Playwright custom
fixture](https://playwright.dev/docs/test-fixtures) so every test
gets a clean, isolated set of mocks. Here's the whole integration
in one file:

```ts
// tests/fixtures.ts
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";
import * as mockttp from "mockttp";

export const test = base.extend<{ mocks: mockttp.Mockttp }, { mockttp: mockttp.Mockttp }>({
  mockttp: [async ({}, use) => {
    const ca = await mockttp.generateCACertificate();
    // 👉 swap the prefix for your project name if you like
    const dir = await fs.mkdtemp(join(tmpdir(), "mockttp-ca-"));
    const caCertPath = join(dir, "ca.pem");
    await fs.writeFile(caCertPath, ca.cert);

    const server = mockttp.getLocal({ https: { cert: ca.cert, key: ca.key } });
    await server.start();
    await server.forUnmatchedRequest().thenPassThrough();
    await use(server);
    await server.stop();
  }, { scope: "worker" }],

  mocks: async ({ mockttp }, use) => {
    await use(mockttp);
    await mockttp.reset();
    await mockttp.forUnmatchedRequest().thenPassThrough();
  },
});

export { expect } from "@playwright/test";
```

A quick tour of the moving parts:

*   The **`mockttp` fixture is worker-scoped** — one mockttp server
    and one CA per Playwright worker.
*   The **`mocks` fixture is test-scoped** — each test gets a
    clean rule set thanks to `mockttp.reset()` on teardown.
*   `forUnmatchedRequest().thenPassThrough()` is our **default**
    so that requests we didn't mock still go through. `reset()`
    clears it too, so we re-add it after.

## Why `webServer` in `playwright.config.ts` Doesn't Fit

Playwright ships a [`webServer` config option](https://playwright.dev/docs/test-webserver)
that boots your app before tests run:

```ts
// playwright.config.ts
export default defineConfig({
  webServer: {
    command: "npm run dev",
    port: 5173,
  },
});
```

It's convenient — but it starts **one process for the whole test
run**, before any worker fixture has a chance to set up. Our
mockttp instance is **per-worker**, with its own CA and its own
port, so the `webServer` process can't pick up the right
`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` — those env vars don't
exist at the time it boots.

The fix: spawn the dev server yourself from a worker fixture
(again, [custom fixtures docs](https://playwright.dev/docs/test-fixtures)),
pass in the proxy's env, and override `baseURL` so
`page.goto("/")` still works:

```ts
// tests/fixtures.ts (continued)
import * as childProcess from "node:child_process";

test.extend<{}, { devServer: { baseURL: string } }>({
  devServer: [async ({ mockttp }, use) => {
    const child = childProcess.spawn(
      // 👉 replace with your dev-server command
      // (e.g. "next", ["dev"]; "pnpm", ["dev"]; "bin/rails", ["server"])
      "npx", ["vite"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...mockttp.proxyEnv,
          NODE_USE_ENV_PROXY: "1",
          NODE_EXTRA_CA_CERTS: mockttp.caCertPath,
          // 👉 most servers honour PORT; some take --port 0 instead
          PORT: "0",
        },
      },
    );
    const baseURL = await new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (chunk) => {
        buf += chunk.toString();
        // 👉 swap the regex for whatever your dev server prints when ready
        const m = buf.match(/Listening on (https?:\S+)/);
        if (m) resolve(m[1]);
      });
      child.once("exit", (code) =>
        reject(new Error(`dev server exited with code ${code}`)),
      );
    });
    await use({ baseURL });
    // Assumes the dev server handles SIGTERM cleanly.
    child.kill("SIGTERM");
  }, { scope: "worker" }],

  baseURL: async ({ devServer }, use) => {
    await use(devServer.baseURL);
  },
});
```

A tour of the env vars we pass in:

*   `mockttp.proxyEnv` gives us `HTTP_PROXY` and `HTTPS_PROXY`
    pointing at the worker's mockttp.
*   `NODE_USE_ENV_PROXY=1` makes Node's built-in `fetch` honor
    `HTTPS_PROXY` (Node 20+).
*   `NODE_EXTRA_CA_CERTS` only accepts a file path, so we write
    the CA to a temp file.
*   `PORT: "0"` lets the OS hand the dev server a free port — no
    collisions when workers run in parallel. We then parse the
    actual port out of stdout once the server is up.


## Writing a Test

Now the fun part — mocks live right next to the assertions that
depend on them:

```ts
// tests/recipes.spec.ts
import { test, expect } from "./fixtures";

test("summarises a recipe", async ({ page, mocks }) => {
  const endpoint = await mocks
    .forPost("https://api.openai.com/v1/chat/completions")
    .thenJson(200, { choices: [{ message: { content: "Pasta." } }] });

  await page.goto("/recipes/123");
  await page.getByRole("button", { name: "Summarise" }).click();
  await expect(page.getByText("Pasta.")).toBeVisible();

  expect(await endpoint.getSeenRequests()).toHaveLength(1);
});
```

No shared `mocks/` directory, no "which canned response is this
test using?" question. **The test owns its mocks.**

## Beyond HTTP: A Test Channel for Anything

Here's a fun trick once you have this set up. The proxy isn't just
for real third-party APIs — it can act as a **general-purpose RPC
channel between your server code and the test runner**. Anything
that's awkward to mock (clocks, random IDs, feature flags,
filesystem state) can be replaced with a small HTTP call to a
fictitious `http://playwright/...` URL when the app is under test:

```ts
// app/server/clock.ts
export async function now(): Promise<Date> {
  // 👉 use whatever env var your project sets in test mode
  if (process.env.NODE_ENV === "test") {
    const res = await fetch("http://playwright/clock");
    return new Date(await res.text());
  }
  return new Date();
}
```

Then in the test, you respond to it:

```ts
// tests/billing.spec.ts
import { test } from "./fixtures";

test("renews subscription on the day it expires", async ({ page, mocks }) => {
  await mocks
    .forGet("http://playwright/clock")
    .thenReply(200, "2030-01-15T00:00:00Z");

  // …drive the UI; the server now thinks it's January 15th.
});
```

## Gotchas

A few more notes:

*   **Forgotten mocks hit the real network.** In CI, swap the
    passthrough default for a loud `thenReply(599, …)`.
*   **In-process apps need `undici`'s `ProxyAgent`** instead of the
    env vars — the env-variable trick only works for child
    processes.
*   **mockttp has an admin-server/remote control mode.** If you cannot spawn the app from inside your worker process,
    you can use this to connect to a mockttp instance running in a separate process.
*   **`mockttp.reset()` clears everything**, including the
    passthrough — re-add it on teardown.

That's it! Two fixtures, the full mockttp API at your
fingertips, and no test seams in your production code.

**Happy mocking with Playwright and mockttp!** 🎭
