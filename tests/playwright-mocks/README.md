# playwright-mocks

Playwright-shape `page.route()` / `Request` / `Response` API for mocking
outbound HTTP(S) in Node test processes, backed by [mockttp].

```ts
test("dedup posts the right items", async ({ page, mocks }) => {
  await mocks.route("https://api.openai.com/**", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: dedup(body) });
  });

  const [req] = await Promise.all([
    mocks.waitForRequest("https://api.openai.com/**"),
    page.getByRole("button", { name: "Finalise" }).click(),
  ]);
  expect(req.postDataJSON()).toMatchObject({ model: /gpt/ });
});
```

The library is currently vendored inside the `cookbook` repo. The
folder is shaped so a future maintainer can lift it out into a
standalone npm package with minimal cleanup (add a `package.json`,
bump TS targets, that's about it).

## Why this exists

We wanted `page.route()`-style ergonomics for mocking the **app's**
outbound HTTP traffic — OpenAI, kptncook, image hosts — not the
browser's. Playwright's built-in routing only sees what the browser
fetches. Everything the server-side app does (SSR loaders, MCP
tools, image proxying) is invisible to it.

mockttp does the heavy lifting: TLS/MITM, cert generation, HTTP
parsing, streaming, passthrough. This library is a thin facade
(~600 LOC) that gives mockttp a Playwright-shaped surface, including:

- Deferred `Route` (fulfill can resolve after the handler returns)
- Handler chains with `route.fallback()`
- `{ times }` auto-removal
- `waitForRequest` / `waitForResponse`
- Glob patterns matching Playwright's
- Fixtures composable via `mergeTests`

## Install

```sh
npm install --save-dev playwright-mocks mockttp undici @playwright/test
```

(Right now `playwright-mocks` isn't on npm — import via the relative
path inside this repo.)

## Quickstart with fixtures

The library ships a Playwright `test` extension; merge it into yours:

```ts
// tests/fixtures.ts
import { test as base, mergeTests } from "@playwright/test";
import { test as mocksTest } from "./playwright-mocks/src";

const appTest = base.extend<MyFixtures, MyWorkerFixtures>({
  // your fixtures here. `workerProxy` is available as an input,
  // so e.g. a dev-server fixture can merge `workerProxy.env`
  // into its child process.
  devServer: [
    async ({ workerProxy }, use) => {
      const child = spawn("vite", { env: { ...process.env, ...workerProxy.env } });
      // …
      await use(handle);
    },
    { scope: "worker" },
  ],
});

export const test = mergeTests(mocksTest, appTest);
```

Tests use the `mocks` fixture; it's worker-scoped under the hood but
the test-scope handle clears routes + listeners on teardown:

```ts
import { test, expect } from "./fixtures";

test("foo", async ({ page, mocks }) => {
  await mocks.route("https://example.com/api/**", (r) => r.fulfill({ json: { ok: true } }));
  // …
});
```

If you don't list `mocks` in a test's args, teardown is skipped and
the test pays nothing.

### Without fixtures

`createProxy()` returns the same `Proxy` object the fixture exposes,
useful for self-tests and one-off scripts:

```ts
import { createProxy } from "./playwright-mocks/src";
import { ProxyAgent, fetch } from "undici";

const proxy = await createProxy();
await proxy.route("https://example.com/**", (r) => r.fulfill({ json: { hi: 1 } }));
const res = await fetch("https://example.com/", {
  dispatcher: new ProxyAgent({
    uri: proxy.url,
    proxyTls: { ca: proxy.caCertPem },
    requestTls: { ca: proxy.caCertPem },
  }),
});
await proxy.close();
```

## API

### `createProxy(options?)` → `Promise<Proxy>`

Options:
- `trustedUpstreamCa?: string | string[]` — extra CA PEMs to trust
  when passing through to the real upstream. Only useful when the
  upstream is itself a test fixture with a synthetic cert.

The returned `Proxy` exposes:

- `url` — `http://127.0.0.1:NNNNN` of the forward proxy.
- `caCertPath` — file path to the auto-generated CA cert (PEM).
- `caCertPem` — same content as a string.
- `env` — `{ HTTPS_PROXY, HTTP_PROXY, NO_PROXY, NODE_USE_ENV_PROXY,
  NODE_EXTRA_CA_CERTS }`. Merge into a child process to route its
  HTTP through us.
- `route(pattern, handler, opts?)` — register. Latest-registered wins.
- `unroute(pattern, handler?)` — remove specific registration(s).
- `unrouteAll()` — clear all registrations.
- `on/once/off(event, listener)` — `"request"`, `"response"`,
  `"requestfinished"`, `"requestfailed"`.
- `removeAllListeners(event?)`.
- `waitForRequest(urlOrPredicate, { timeout? })` — race-free.
- `waitForResponse(urlOrPredicate, { timeout? })`.
- `close()` — shut down mockttp + tmp CA cleanup.

### `Route`

- `route.request(): ProxyRequest`
- `route.url(): string`
- `route.fulfill({ status?, statusText?, headers?, body?, json?, path?, contentType?, response? })`
- `route.continue({ url?, method?, headers?, body? })` — forward to
  upstream (possibly rewritten) and fulfill from the result.
- `route.fetch({ url?, … })` — forward and return the `Response`
  for the handler to mutate before calling `fulfill({ response })`.
- `route.abort(reason?)` — TCP reset.
- `route.fallback()` — delegate to the next matching handler;
  passthrough if the chain exhausts.

All terminal methods may be called **after** the handler returns
(Playwright contract). The chain walker blocks the underlying
mockttp callback until the route settles.

### `ProxyRequest`

- `url() / method() / headers() / allHeaders()`
- `headerValue(name) / headerValues(name)` — case-insensitive
- `postData() / postDataBuffer() / postDataJSON()`
- `response(): Promise<ProxyResponse | null>` — resolves with `null`
  on abort/fail.

### `ProxyResponse`

- `url() / status() / statusText() / ok()`
- `headers() / allHeaders() / headerValue() / headerValues()`
- `body() / text() / json()`
- `request(): ProxyRequest` — back-link.

### URL patterns

`string | RegExp | (url: URL) => boolean`. The glob compiler
understands `*`, `**`, `?`, `[abc]`, `{a,b}` — Playwright-compatible.

## Gaps vs Playwright

These are structurally unreachable from a forward proxy and won't be
implemented:

- `request.frame()`, `resourceType()`, `redirectedFrom/To()`,
  `timing()`, `securityDetails()`, `sizes()`, `serviceWorker()` —
  all browser-side metadata.
- Per-page / per-context route scoping — there's no browser context
  here, just one process-wide proxy.
- `routeFromHAR`, `routeWebSocket` — not implemented; PRs welcome.
- Granular `abort` error codes (`namenotresolved` etc.) — TCP reset
  is the only signal a forward proxy can produce.

## Architecture

```
spec
 └── proxy.route / on / waitForRequest / …
      └── Proxy facade  (this lib)
           ├── Route        (deferred-based settler)
           ├── Chain walker (LIFO + fallback + times)
           └── EventEmitter (request / response / requestfinished / requestfailed)
                └── mockttp  (TLS-MITM, HTTP parsing, streaming, passthrough)
```

mockttp owns the wire. We layer:

1. **Single mockttp rule** whose `.matching()` predicate consults a
   live registration list. Adds/removes take effect immediately —
   no rule re-install.
2. **Chain walker** in `.thenCallback()` iterates matching handlers
   LIFO, hands each a fresh `Route`, awaits `_settled`. Decrements
   `times`; splices at zero. `fallback` advances; chain exhaustion
   triggers an internal `route.continue()` (passthrough via undici).
3. **Bridge** subscribes to mockttp's `request` / `response` /
   `abort` events and re-emits as Playwright-shape events. Cache
   keyed by `req.id` so `request.response()` and the various
   `requestfinished` / `requestfailed` events line up regardless of
   bridge-vs-walker ordering.

## Module layout

```
src/
  index.ts          — public exports
  server.ts         — createProxy, Proxy handle
  route.ts          — Route, FulfillOptions, ContinueOptions
  request.ts        — ProxyRequest + builder
  response.ts       — ProxyResponse + builder
  chain.ts          — Registration, walker, request cache
  matcher.ts        — matchPattern + glob compiler
  events.ts         — waitFor + EventEmitter helpers
  fixtures.ts       — Playwright `test` extension
  internal/
    headers.ts      — normalisation, hop-by-hop set, body helpers
    mime.ts         — extension → content-type
tests/
  self.spec.ts      — exercises the public surface end-to-end
```

[mockttp]: https://github.com/httptoolkit/mockttp
