# Mocking Outbound HTTP in Playwright with `playwright-server-side-mocking`

When your app calls third-party APIs — OpenAI, Stripe, a recipe
scraper — your Playwright tests probably shouldn't. Real responses
are slow, flaky, and rate-limited, and you really don't want to
spend money every time CI runs.

In this post we'll use [**`playwright-server-side-mocking`**](https://www.npmjs.com/package/playwright-server-side-mocking)
to mock the app's outbound HTTPS calls with the same `page.route()`
API you already know — only this time it works on **server-side**
traffic, not just the browser's.

## The Idea

Playwright's built-in `page.route()` only sees what the browser
fetches. Everything the server-side app does — SSR loaders, MCP
tools, image proxying — is invisible to it.

`playwright-server-side-mocking` fills that gap. Under the hood it spins up an
HTTPS forward proxy ([mockttp](https://github.com/httptoolkit/mockttp))
per Playwright worker. On top, it gives you the familiar
Playwright shape:

*   🛣️ `mocks.route(url, handler)` with glob patterns
*   📨 `route.fulfill({ json: … })`, `route.fallback()`, `route.continue()`
*   ⏳ `mocks.waitForRequest(url)` / `waitForResponse(url)`
*   🔁 `{ times: N }` auto-removal

If you've used `page.route()`, you already know the API.

## Setting Up the Fixture

First, install the package:

```sh
npm install --save-dev playwright-server-side-mocking
```

Then merge its fixtures into your test file:

```ts
// tests/fixtures.ts
import { test as base, mergeTests } from "@playwright/test";
import { test as mocksTest } from "playwright-server-side-mocking";

export const test = mergeTests(mocksTest, base);
export { expect } from "@playwright/test";
```

That's it. Tests now have access to:

*   The **`workerProxy` fixture (worker-scoped)** — exposes
    `workerProxy.env`, an env block to merge into your dev-server
    child process so its outbound HTTPS routes through the mock.
*   The **`mocks` fixture (test-scoped)** — the Playwright-shape
    routing API. Each test starts with no routes registered and
    no leaked listeners.

## Why You Can't Use `webServer`

Playwright's built-in `webServer` config starts **one process for
the whole test run**, but our proxy is **per-worker**. That means
the dev server can't pick up the right `HTTPS_PROXY` and CA — there
isn't one yet at the time it boots.

The fix: spawn the dev server yourself from a worker fixture, pass
in `workerProxy.env`, and override `baseURL` so `page.goto("/")`
still works:

```ts
test.extend<{}, { server: { baseURL: string } }>({
  server: [async ({ workerProxy }, use) => {
    const child = spawn("npx", ["vite"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...workerProxy.env, PORT: "0" },
    });
    const baseURL = await readyURLFromStdout(child); // parse "Listening on http://…"
    await use({ baseURL });
    child.kill("SIGTERM");
  }, { scope: "worker" }],

  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },
});
```

One practical tip: set `PORT: "0"` so the OS hands the dev server
a free port — no collisions when workers run in parallel. Then
parse the actual port out of stdout once the server is up.

## Writing a Test

Now the fun part — mocks live right next to the assertions that
depend on them, with the same shape you'd use for browser routes:

```ts
test("summarises a recipe", async ({ page, mocks }) => {
  await mocks.route("https://api.openai.com/**", async (route) => {
    await route.fulfill({
      json: { choices: [{ message: { content: "Pasta." } }] },
    });
  });

  const [request] = await Promise.all([
    mocks.waitForRequest("https://api.openai.com/**"),
    (async () => {
      await page.goto("/recipes/123");
      await page.getByRole("button", { name: "Summarise" }).click();
    })(),
  ]);

  await expect(page.getByText("Pasta.")).toBeVisible();
  expect(request.postDataJSON()).toMatchObject({ model: /gpt/ });
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
// somewhere in your server code
async function now(): Promise<Date> {
  if (process.env.NODE_ENV === "test") {
    const res = await fetch("http://playwright/clock");
    return new Date(await res.text());
  }
  return new Date();
}
```

Then in the test, you respond to it:

```ts
test("renews subscription on the day it expires", async ({ page, mocks }) => {
  await mocks.route("http://playwright/clock", (route) =>
    route.fulfill({ body: "2030-01-15T00:00:00Z" }),
  );

  // …drive the UI; the server now thinks it's January 15th.
});
```

Because the test owns the route handler, it's an HTTP boundary
*between processes you control*, not a fragile import-time mock.
Same proxy, same fixture — every test seam in your app turns into
a one-liner.

## Not Just Node

Although this post uses a Node dev server as the example, **none
of this is Node-specific**. The proxy is a plain HTTPS forward
proxy. Any language whose HTTP client honors the
`HTTP_PROXY`/`HTTPS_PROXY` env vars will route through it: Go,
Python (`requests`, `httpx`), Ruby (`Net::HTTP`), Rust
(`reqwest`), .NET (`HttpClient.DefaultProxy`), and so on. Java
needs `-Dhttps.proxyHost`/`-Dhttps.proxyPort` instead of env vars,
but the same principle applies.

You'll just need to teach each runtime to trust mockttp's
auto-generated CA the way that runtime expects — for example
`SSL_CERT_FILE` for Python and Ruby, `SSL_CERT_DIR` for Go,
`-Djavax.net.ssl.trustStore` for Java. Once that's in place, the
fixture, the routes, and even the "test channel" trick all work
the same.

## Gotchas

A few things to watch out for:

*   **Forgotten routes hit the real network.** By default, anything
    you don't `route()` is passed through. In CI, register a
    catch-all `mocks.route("**", route => route.fulfill({ status: 599 }))`
    early in `beforeEach` to fail loudly.
*   **In-process apps need `undici`'s `ProxyAgent`** instead of the
    env vars — the env-variable trick only works for child processes.

That's it! Two lines of glue, the Playwright API you already know,
and not a single test seam in your production code.

**Happy mocking with Playwright!** 🎭
