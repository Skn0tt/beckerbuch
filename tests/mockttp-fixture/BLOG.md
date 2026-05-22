# Mocking Server Side HTTP in Playwright with mockttp

I've been building a little recipe app for my household. Along the way I needed to mock out third-party APIs in my Playwright tests. For browser requests that's [`page.route()`](https://playwright.dev/docs/network#handle-requests), and it works wonderfully. For server-side HTTP calls, it doesn't.

I tried mock-only branches inside the server code. That got messy fast, especially when the same API had to behave differently in different tests. So I went looking for something cleaner.

I landed on a forward proxy that intercepts outgoing traffic from the server, configured from the test code. Here's how it works.

## The Idea

Instead of patching modules or adding `if (isUnderTest)` branches, we mock at the network boundary. The app makes the same HTTPS calls it always makes. A forward proxy sits in front and decides whether to answer with a canned response or pass the request through.

What makes this work is the `HTTP_PROXY` / `HTTPS_PROXY` env var convention. Almost every HTTP client honours it.

I use [mockttp](https://github.com/httptoolkit/mockttp) as the proxy. It generates a TLS certificate on the fly, runs an HTTP/HTTPS forward proxy in-process, and exposes a fluent rule builder for mocks and interception. We start one per Playwright worker, and every test configures it as it likes.

> The snippets below show a Node dev server, but none of this is Node-specific. Any language whose HTTP client respects `HTTP_PROXY` / `HTTPS_PROXY` works the same way: Python, Go, Ruby, Rust, .NET. Java needs `-Dhttps.proxyHost` / `-Dhttps.proxyPort` instead of env vars. You'll also need to teach each runtime to trust mockttp's certificate: `SSL_CERT_FILE` for Python and Ruby, `SSL_CERT_DIR` for Go, and so on.

## Setting Up the Fixture

We set up mockttp as a [Playwright custom fixture](https://playwright.dev/docs/test-fixtures), so every test gets a clean, isolated set of mocks. Here's the whole integration in one file:

```ts
// tests/fixtures.ts
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";
import * as mockttp from "mockttp";

export const test = base.extend<
  { mocks: mockttp.Mockttp },
  { mockttp: { server: mockttp.Mockttp; caCertPath: string } }
>({
  mockttp: [async ({}, use) => {
    const ca = await mockttp.generateCACertificate();
    const dir = await fs.mkdtemp(join(tmpdir(), "mockttp-ca-"));
    const caCertPath = join(dir, "ca.pem");
    await fs.writeFile(caCertPath, ca.cert);

    const server = mockttp.getLocal({ https: { cert: ca.cert, key: ca.key } });
    await server.start();
    await server.forUnmatchedRequest().thenPassThrough();
    await use({ server, caCertPath });
    await server.stop();
  }, { scope: "worker" }],

  mocks: async ({ mockttp }, use) => {
    await use(mockttp.server);
    await mockttp.server.reset();
    await mockttp.server.forUnmatchedRequest().thenPassThrough();
  },
});

export { expect } from "@playwright/test";
```

A quick tour of the moving parts:

1.  The `mockttp` fixture is **worker-scoped** and returns both the server and the certificate path. One mockttp server and one TLS certificate per Playwright worker.
2.  The `mocks` fixture is **test-scoped** and exposes the server directly, so tests can write `mocks.forPost(...)`. Each test gets a clean rule set thanks to `mockttp.server.reset()` on teardown.
3.  [`forUnmatchedRequest().thenPassThrough()`](https://httptoolkit.com/docs/mockttp/api/classes/Mockttp/#forunmatchedrequest) is our default, so requests we didn't mock still go through. `reset()` clears it too, so we re-add it after.

## Spinning Up the Dev Server

For mocking to work, the dev server has to know about the mockttp instance. It needs `HTTPS_PROXY` pointing at our proxy and `NODE_EXTRA_CA_CERTS` pointing at our certificate, both of which are per-worker. So we spawn it ourselves from a worker fixture, pass in the right env, and override `baseURL` so `page.goto("/")` still works.

```ts
// tests/fixtures.ts
import * as childProcess from "node:child_process";
// ...other imports as above

export const test = base.extend<
  { mocks: mockttp.Mockttp },
  {
    mockttp: { server: mockttp.Mockttp; caCertPath: string };
    devServer: { baseURL: string };
  }
>({
  // ...mockttp and mocks fixtures from above...

  devServer: [async ({ mockttp }, use) => {
    const child = childProcess.spawn(
      "npm", ["start"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HTTP_PROXY: mockttp.server.url,
          HTTPS_PROXY: mockttp.server.url,
          NODE_USE_ENV_PROXY: "1",
          NODE_EXTRA_CA_CERTS: mockttp.caCertPath,
          PORT: "0",
        },
      },
    );
    const baseURL = await new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/Listening on (https?:\S+)/);
        if (m) resolve(m[1]);
      });
      child.once("exit", (code) =>
        reject(new Error(`dev server exited with code ${code}`)),
      );
    });
    await use({ baseURL });
    child.kill("SIGTERM");
  }, { scope: "worker" }],

  baseURL: async ({ devServer }, use) => {
    await use(devServer.baseURL);
  },
});
```

A tour of the env vars we pass in:

1.  `HTTP_PROXY` and `HTTPS_PROXY` point at the worker's mockttp via [`server.url`](https://httptoolkit.com/docs/mockttp/api/classes/Mockttp/#url).
2.  `NODE_USE_ENV_PROXY=1` makes [Node's built-in `fetch`](https://nodejs.org/api/cli.html#node_use_env_proxy1) honor `HTTPS_PROXY` (Node 20+).
3.  `NODE_EXTRA_CA_CERTS` only accepts a file path, which is why the worker fixture writes the certificate to one.
4.  `PORT: "0"` lets the OS hand the dev server a free port, so workers don't collide. We parse the actual port out of stdout once the server is up.

## Why Not Playwright's `webServer`?

Playwright ships a [`webServer` config option](https://playwright.dev/docs/test-webserver) that boots your app before tests run:

```ts
// playwright.config.ts
export default defineConfig({
  webServer: {
    command: "npm start",
    port: 5173,
  },
});
```

It's convenient, but it starts one process for the whole test run, before any worker fixture has a chance to set up. The test worker that starts the proxy doesn't exist yet at that point, so `webServer` can't pick up `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS`. That's why we spawn the server from a fixture instead.


## Writing a Test

Now the fun part. Mocks live right next to the assertions that depend on them:

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

No shared `mocks/` directory, no "which canned response is this test using?" question. The test owns its mocks.

## Beyond HTTP: A Test Channel for Anything

Here's a neat trick once you have this set up. The proxy isn't just for real third-party APIs. It can act as a general-purpose RPC channel between your server code and the test runner. Anything that's awkward to mock (clocks, random IDs, feature flags, filesystem state) can be replaced with a small HTTP call to a fictitious `http://playwright/...` URL when the app is under test:

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

1.  **Forgotten mocks hit the real network.** Consider swapping the passthrough default for a loud `thenReply(599, …)`.
2.  **In-process apps need [`undici`'s `ProxyAgent`](https://undici.nodejs.org/#/docs/api/ProxyAgent)** instead of the env vars. The env-variable trick only works for child processes.
3.  **mockttp has an [admin-server / remote control mode](https://httptoolkit.com/docs/mockttp/#standalone).** If you can't spawn the app from inside your worker process, you can connect to a mockttp instance running in a separate process.
4.  **`mockttp.reset()` clears everything**, including the passthrough. Remember to re-add it on teardown.

That's it. Happy mocking!
