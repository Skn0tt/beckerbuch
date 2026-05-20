# tests/

Playwright end-to-end tests. Real app, real Postgres, real session
cookies. See [TECH.md §10](../TECH.md) for the full testing model.

## Layout

| File                    | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `global-setup.ts`       | Boots a `postgres:16` Testcontainer, enables extensions, runs `drizzle-kit push`, and writes `DATABASE_URL` into `process.env` so worker fixtures inherit it. |
| `fixtures.ts`           | Playwright `test` extended with worker fixtures (`mockttp`, `server`, `baseURL` override) and test fixtures (`flat`, opt-in `proxy`). Also exports `generateInvite(page, user)` for tests that need an invite URL — it logs the user in, drives the `/flat/settings` UI, and returns the freshly minted link. The `flat` fixture provisions a flat via the admin endpoint, then redeems the bootstrap invite via the public form to mint a real first user. |
| `login.ts`              | Thin `login(page, user)` helper that fills the real form.     |
| `proxy/`                | Test fixtures + helpers for the per-worker mockttp proxy. See [Mocking external APIs](#mocking-external-apis) below. |
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
[mockttp](https://github.com/httptoolkit/mockttp) proxy that the
`mockttp` worker fixture (`tests/fixtures.ts`) starts **once per
Playwright worker**. The `server` worker fixture wires the
worker's Vite dev server to it via `HTTPS_PROXY` +
`NODE_USE_ENV_PROXY=1` + `NODE_EXTRA_CA_CERTS`, so Node's global
`fetch` natively routes through the proxy and trusts its generated
CA. **App code calls real production URLs**
(`https://mobile.kptncook.com`, `https://api.openai.com`, …) — there
is no test-only base-URL env var or `if (test)` branch in `app/`.

Specs that need mocks opt in to the test-scoped **`proxy` fixture**
and register handlers explicitly via helpers from `proxy/mocks.ts`:

```ts
import { test, expect } from "./fixtures";
import { mockKptncook } from "./proxy/mocks";
import { MOCK_RECIPES } from "./proxy/fixtures";

test("import a recipe", async ({ page, flat, proxy }) => {
  await mockKptncook(proxy, [MOCK_RECIPES.cinnamonBuns]);
  // …
});
```

There are **no auto-registered default handlers**: tests that don't
mock anything will see the proxy's default policy (pass through to the
real network) for any outbound request the app makes. The `proxy`
fixture resets the mockttp on teardown, so handlers never leak
between tests on the same worker.

Layout under `tests/proxy/`:

| File         | What it does                                                |
| ------------ | ----------------------------------------------------------- |
| `fixtures.ts`| Shared test payloads (the cinnamon-buns kptncook recipe, the tiny 1×1 JPEG, the kptncook API key the helper accepts). Imported by both mock helpers and specs. |
| `mocks.ts`   | `mockKptncook` / `mockKptncookShareRedirects` / `mockKptncookSearch` / `mockKptncookImages` for kptncook surfaces. `mockOpenAiDedup(proxy, { merges }|{ fail: true })` for OpenAI chat-completions (matches both `api.openai.com/v1/...` and `<site>/.netlify/ai/...` paths). |

To mock a new external API, add a `mock*` helper to `proxy/mocks.ts`
and call it from the specs that need it. No app-code changes
required.

