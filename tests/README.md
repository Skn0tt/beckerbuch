# tests/

Playwright end-to-end tests. Real app, real Postgres, real session
cookies. See [TECH.md §10](../TECH.md) for the full testing model.

## Layout

| File                    | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `global-setup.ts`       | Boots a `postgres:16` Testcontainer, enables extensions, runs `drizzle-kit push`, and writes `DATABASE_URL` into `process.env` so worker fixtures inherit it. |
| `fixtures.ts`           | Playwright `test` extended with worker fixtures (`workerProxy`, `server`, `baseURL` override) and test fixtures (`flat`, opt-in `mocks`). Also exports `generateInvite(page, user)` for tests that need an invite URL — it logs the user in, drives the `/flat/settings` UI, and returns the freshly minted link. The `flat` fixture provisions a flat via the admin endpoint, then redeems the bootstrap invite via the public form to mint a real first user. |
| `login.ts`              | Thin `login(page, user)` helper that fills the real form.     |
| `proxy/`                | Bespoke HTTPS-MITM forward proxy + Playwright-shaped `Route` API. See [Mocking external APIs](#mocking-external-apis) below. |
| `mock-handlers.ts`      | Closure-factory helpers that build reusable `route` handlers (kptncook share/search/images, OpenAI dedup) without registering them — specs hand the returned handler to `mocks.route(...)` themselves. |
| `mock-data.ts`          | Shared test payloads (cinnamon-buns recipe, tiny 1×1 JPEG, kptncook API key). |
| `*.spec.ts`             | Specs. Import `test`/`expect` from `./fixtures`.              |

The app's HTTP boundary is the only seam tests use — there's no direct
DB access from the test process. `globalSetup` owns the Postgres
testcontainer and the schema; each Playwright worker owns its own
Vite dev server (with `@netlify/vite-plugin` providing the Blobs/etc.
emulation that we'd otherwise need `netlify dev` for).

## Conventions

- **Each test gets its own flat**, not a shared seed. We rely on
  multi-tenancy (one user, one flat per test) for isolation rather
  than truncating tables. No global reset.
- **Tests act like real users.** No `/_test/*` routes, no `loginAs`
  shortcut, no `mintSession`, no `storageState`. The `login()` helper
  fills the actual form, and even `createFlat` walks the public invite
  redemption form.
- **Test-only setup that can't go through the UI** (provisioning a
  brand-new flat with no founder yet) lives behind `/admin/*`
  endpoints, guarded by `ADMIN_TOKEN`. Tests hit those via Playwright's
  `request` fixture — never via direct DB writes.
- `fullyParallel: true` — per-test flats make data isolation safe by
  construction. No `retries`: if a test fails it's a real bug, not a flake.

## Running

```bash
npm test                          # the whole suite
npx playwright test smoke.spec    # a single file
npx playwright test --debug       # step through with the inspector
npx playwright test --ui          # time-travel UI
```

Drop `await page.pause()` anywhere in a spec to freeze the run, open
the inspector, and click around the live app + DB state.

## Reuse mode

For fast local iteration, `globalSetup` labels the testcontainer with
`withReuse()`, so subsequent runs reuse the same Postgres instance.
CI cold-starts.

## Mocking external APIs

The app calls two external services: kptncook (recipe import) and
OpenAI (shopping-list dedup). Both are mocked at the HTTP layer by a
small bespoke HTTPS-MITM forward proxy under `tests/proxy/` that the
`workerProxy` worker fixture starts **once per Playwright worker**.
The `server` worker fixture wires the worker's Vite dev server to it
via `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` + `NODE_EXTRA_CA_CERTS`,
so Node's global `fetch` natively routes through the proxy and
trusts its generated CA. **App code calls real production URLs**
(`https://mobile.kptncook.com`, `https://api.openai.com`, …) — there
is no test-only base-URL env var or `if (test)` branch in `app/`.

The test-facing API is shaped like Playwright's `page.route()`:
specs opt in to the test-scoped **`mocks` fixture** and call
`mocks.route(pattern, handler)` directly. `pattern` is a glob string
(`*`, `**`), a `RegExp`, or a `(url: URL) => boolean` predicate. The
handler receives a `Route` with `request()`, `url()`, and
`fulfill / continue / abort / fetch` — mirroring Playwright.

```ts
import { test, expect } from "./fixtures";
import { MOCK_RECIPES } from "./mock-data";
import { kptncookShareRedirectHandler } from "./mock-handlers";

test("import a recipe", async ({ page, flat, mocks }) => {
  await mocks.route(
    /^https:\/\/share\.kptncook\.com\/[^/]+$/,
    kptncookShareRedirectHandler([MOCK_RECIPES.cinnamonBuns]),
  );
  // …or write the handler inline:
  await mocks.route("https://api.openai.com/v1/chat/completions", async (route) => {
    await route.fulfill({ status: 200, json: { /* … */ } });
  });
});
```

There are **no auto-registered default handlers**: any request not
matched by a route falls through to a real-network passthrough. The
`mocks` fixture clears routes on teardown, so handlers never leak
between tests on the same worker.

`mock-handlers.ts` exposes closure factories — `openAiDedupHandler`,
`kptncookShareRedirectHandler`, `kptncookSearchHandler`,
`kptncookImagesHandler` — that return a ready-to-use route callback.
The factories don't touch the proxy; specs hand the returned handler
to `mocks.route(...)` themselves, keeping setup local to the test.

Layout under `tests/proxy/`:

| File             | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `ca.ts`          | Per-worker root CA (RSA-2048 via `node-forge`).          |
| `cert-cache.ts`  | LRU-cached per-host leaf certs minted on demand.         |
| `server.ts`      | HTTP/CONNECT proxy: terminates TLS with the synthetic cert, parses the decrypted request, dispatches to the registered route or falls through to real-network passthrough. |
| `route.ts`       | `Route` (Playwright-shaped) + glob/RegExp/predicate matcher. |
| `index.ts`       | Public exports.                                          |

