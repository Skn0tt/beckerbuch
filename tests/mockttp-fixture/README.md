# mockttp-fixture

The bare-minimum [mockttp] + [@playwright/test] integration. Sibling
of [`playwright-mocks/`](../playwright-mocks/README.md) — read both
to see what a Playwright-shape facade buys (and costs).

```ts
test("uses the real mockttp API", async ({ page, mocks }) => {
  await mocks
    .forGet("https://api.example.com/items")
    .thenJson(200, { items: [1, 2, 3] });

  await page.goto("/");
  await expect(page.getByText("3 items")).toBeVisible();
});
```

`mocks` is the **raw `Mockttp` instance**. No wrapper. Use mockttp's
own [rule-builder API][mockttp-docs] (`forGet`, `forPost`, `matching`,
`thenJson`, `thenCallback`, `thenPassThrough`, `on('request', …)`,
`getSeenRequests()`, …) directly.

## What this library is

A ~100-LOC wrapper around the boilerplate every mockttp + Playwright
user has to write anyway:

- A worker-scoped fixture that boots one mockttp HTTPS server per
  Playwright worker and stops it on teardown.
- An auto-generated CA, written to a tmp file so child processes can
  trust it via `NODE_EXTRA_CA_CERTS`.
- An `env` block (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`,
  `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`) to merge into a
  system-under-test child process.
- A test-scoped fixture that exposes the server and calls
  `server.reset()` on teardown so tests don't leak rules.
- A pass-through default for unmatched requests — without it
  mockttp 503s every URL you forgot to mock.

That's everything. No routing facade, no events bridge, no waiters,
no glob compiler — those live in `playwright-mocks/`.

## Quickstart

```ts
// tests/fixtures.ts
import { test as base, mergeTests } from "@playwright/test";
import { test as mockttpTest } from "./mockttp-fixture/src";

const appTest = base.extend<MyFixtures, MyWorkerFixtures & { workerProxy: import("./mockttp-fixture/src").MockttpHandle }>({
  devServer: [
    async ({ workerProxy }, use) => {
      const child = spawn("vite", { env: { ...process.env, ...workerProxy.env } });
      // …
      await use(handle);
    },
    { scope: "worker" },
  ],
});

export const test = mergeTests(mockttpTest, appTest);
```

```ts
// any spec
import { test, expect } from "./fixtures";

test("foo", async ({ page, mocks }) => {
  const endpoint = await mocks
    .forPost("https://api.openai.com/v1/chat/completions")
    .thenJson(200, { choices: [{ message: { content: "hi" } }] });

  await page.goto("/").then(() => page.getByRole("button").click());

  const requests = await endpoint.getSeenRequests();
  expect(requests).toHaveLength(1);
  expect(await requests[0].body.getJson()).toMatchObject({ model: /gpt/ });
});
```

## Comparison with `playwright-mocks`

| Aspect                    | `mockttp-fixture`            | `playwright-mocks`           |
| ------------------------- | ---------------------------- | ---------------------------- |
| Lifecycle / CA / env      | ✓                            | ✓                            |
| Per-test cleanup          | `server.reset()`             | `unrouteAll()` + listeners   |
| Pass-through default      | ✓                            | ✓                            |
| `mergeTests`-friendly     | ✓                            | ✓                            |
| API surface               | raw mockttp                  | Playwright `page.route`-shape |
| Route handlers            | `thenCallback(req => …)`     | `(route) => route.fulfill(…)` |
| Settle after handler ret. | ✗ (must resolve in callback) | ✓ (deferred-based)           |
| Handler chains / fallback | ✗                            | ✓                            |
| `{ times: N }` auto-unreg | ✗                            | ✓                            |
| Targeted `unroute`        | ✗ (reset clears everything)  | ✓                            |
| URL globs (`**`, `{a,b}`) | ✗ (mockttp's own matchers)   | ✓                            |
| `waitForRequest/Response` | ✗ (use `server.on('request')` + ad-hoc Promise) | ✓ (race-free) |
| `request.response()` link | ✗                            | ✓                            |
| `Request`/`Response` shape | mockttp's `CompletedRequest` | Playwright-shape (`postDataJSON`, `headerValue`, …) |
| LOC                       | ~100                         | ~700                         |

## When to pick which

**Pick `mockttp-fixture`** when:
- You already know mockttp and prefer its API.
- You want maximum control over rule matching and response building.
- You only need a handful of mocks per test and don't mind verbosity.
- You don't need to settle a route from outside the handler.

**Pick `playwright-mocks`** when:
- Your team's intuition is Playwright's `page.route()` — minimal
  context switch.
- You want `waitForRequest` / `waitForResponse` ergonomics for
  asserting on outbound calls.
- You want handler chaining (`route.fallback()`) and per-test
  defaults registered alongside test-specific overrides.
- You want to stash the route and fulfill it later (e.g. inside a
  `Promise.all` race).

Both share the same lifecycle / CA / env model, so switching costs
are low — you'd rewrite the rule declarations, nothing else.

## API

### `createProxy(options?)` → `Promise<MockttpHandle>`

Options:
- `trustedUpstreamCa?: string | string[]` — extra CA PEMs for the
  pass-through default.

Handle:
- `server: Mockttp` — the raw mockttp instance.
- `url`, `caCertPath`, `caCertPem`, `env`, `close()`.

### `test`

Worker fixture `workerProxy: MockttpHandle`, test fixture
`mocks: Mockttp` with `reset()` teardown. Use `mergeTests` to
compose with your own.

[mockttp]: https://github.com/httptoolkit/mockttp
[@playwright/test]: https://playwright.dev/
[mockttp-docs]: https://httptoolkit.github.io/mockttp/
