# Mocking Outbound HTTP in Playwright with mockttp

When your app calls third-party APIs — OpenAI, Stripe, a recipe
scraper — your Playwright tests probably shouldn't. Real responses
are slow, flaky, and rate-limited, and you really don't want to
spend money every time CI runs.

In this post we'll wire up [**mockttp**](https://github.com/httptoolkit/mockttp),
an in-process HTTPS forward proxy, into a Playwright project so
that every test gets a clean, isolated set of mocks — without
touching any application code.

## The Idea

Instead of patching modules or adding a `process.env.TEST` branch,
we mock at the **network boundary**. Our app makes the same HTTPS
calls it always makes; a forward proxy sits in front and decides
whether to answer with a canned response or pass the request through.

mockttp does the heavy lifting:

*   🔐 Generates a CA on the fly
*   🌐 Runs an HTTPS proxy in-process
*   🧱 Provides a fluent rule builder for mocks

All we need to do is start it once per Playwright worker and
expose it to tests as a fixture.

## Setting Up the Fixture

Here's the whole integration in one file:

```ts
// tests/fixtures.ts
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";
import { generateCACertificate, getLocal, type Mockttp } from "mockttp";

type WorkerProxy = { server: Mockttp; env: NodeJS.ProcessEnv };

export const test = base.extend<{ mocks: Mockttp }, { proxy: WorkerProxy }>({
  proxy: [async ({}, use) => {
    const ca = await generateCACertificate();
    const dir = await mkdtemp(join(tmpdir(), "mockttp-ca-"));
    const caCertPath = join(dir, "ca.pem");
    await writeFile(caCertPath, ca.cert);

    const server = getLocal({ https: { cert: ca.cert, key: ca.key } });
    await server.start();
    await server.forUnmatchedRequest().thenPassThrough();

    await use({
      server,
      env: {
        ...server.proxyEnv,                    // HTTP_PROXY + HTTPS_PROXY
        NODE_USE_ENV_PROXY: "1",
        NODE_EXTRA_CA_CERTS: caCertPath,
      },
    });
    await server.stop();
  }, { scope: "worker" }],

  mocks: async ({ proxy }, use) => {
    await use(proxy.server);
    await proxy.server.reset();
    await proxy.server.forUnmatchedRequest().thenPassThrough();
  },
});
```

A quick tour of the moving parts:

*   The **`proxy` fixture is worker-scoped** — one mockttp server
    and one CA per Playwright worker.
*   The **`mocks` fixture is test-scoped** — each test gets a
    clean rule set thanks to `server.reset()` on teardown.
*   `forUnmatchedRequest().thenPassThrough()` is our **default**
    so that requests we didn't mock still go through. `reset()`
    clears it too, so we re-add it after.
*   `server.proxyEnv` gives us `HTTP_PROXY` and `HTTPS_PROXY`
    pointing at the worker's mockttp. We extend it with two more
    env vars Node needs:
*   `NODE_USE_ENV_PROXY=1` makes Node's built-in `fetch` honor
    `HTTPS_PROXY` (Node 20+).
*   `NODE_EXTRA_CA_CERTS` only accepts a file path, so we write
    the CA to a temp file.

## Why You Can't Use `webServer`

Playwright's built-in `webServer` config starts **one process for
the whole test run**, but our proxy is **per-worker**. That means
the dev server can't pick up the right `HTTPS_PROXY` and CA — there
isn't one yet at the time it boots.

The fix: spawn the dev server yourself from a worker fixture, pass
in the proxy's env, and override `baseURL` so `page.goto("/")`
still works:

```ts
test.extend<{}, { server: { baseURL: string } }>({
  server: [async ({ proxy }, use) => {
    const child = spawn("npx", ["vite"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...proxy.env, PORT: "0" },
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
depend on them:

```ts
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
  await mocks
    .forGet("http://playwright/clock")
    .thenReply(200, "2030-01-15T00:00:00Z");

  // …drive the UI; the server now thinks it's January 15th.
});
```

Because the test owns the rule, it's an HTTP boundary *between
processes you control*, not a fragile import-time mock. Same
proxy, same fixture — every test seam in your app turns into a
one-liner.

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
fixture, the rules, and even the "test channel" trick all work
the same.

## Gotchas

A few things to watch out for:

*   **Forgotten mocks hit the real network.** In CI, swap the
    passthrough default for a loud `thenReply(599, …)`.
*   **In-process apps need `undici`'s `ProxyAgent`** instead of the
    env vars — the env-variable trick only works for child processes.
*   **`server.reset()` clears everything**, including the
    passthrough — re-add it on teardown.

That's it! ~50 lines of glue, the full mockttp API at your
fingertips, and not a single test seam in your production code.

**Happy mocking with Playwright and mockttp!** 🎭
