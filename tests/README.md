# tests/

Playwright end-to-end tests. Real app, real Postgres, real session
cookies. See [TECH.md §10](../TECH.md) for the full testing model.

## Layout

| File                    | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `global-setup.ts`       | Boots a `postgres:16` Testcontainer, enables extensions, runs `drizzle-kit push`, builds the app with test-only sourcemaps (`--sourcemapClient inline --sourcemapServer`), and writes `DATABASE_URL` into `process.env` so worker fixtures inherit it. |
| `fixtures.ts`           | Playwright `test` extended with worker fixtures (`workerProxy`, `server`, `baseURL` override) and test fixtures (`flat`, opt-in `mocks`, always-on `_coverage`). Also exports `generateInvite(page, user)` for tests that need an invite URL — it logs the user in, drives the `/flat/settings` UI, and returns the freshly minted link. The `flat` fixture provisions a flat via the admin endpoint, then redeems the bootstrap invite via the public form to mint a real first user. |
| `server-coverage-preload.mjs` | Test-only Node preload: on `SIGUSR2`, `v8.takeCoverage()` + ack line for per-test backend coverage dumps. |
| `coverage-remap.ts`     | Remaps Playwright JSCoverage + Node V8 coverage through source maps into Istanbul-style maps keyed by original `app/` paths; zeroes v8-to-istanbul's default-covered lines before apply so load ≠ hit; also remaps worker inspector precise coverage for in-process `app/` unit tests; writes per-test JSON under `.playwright-data/coverage/` (durable; outside wiped `test-results/`). |
| `coverage-remap.unit.spec.ts` | Pure unit tests for remap helpers (default-count reset, import/404 dumps must not paint unrelated bodies, worker precise coverage → `app/` hits). |
| `coverage-select.ts`    | Library: `buildIndex` over per-test Istanbul maps + `selectTests` (diminishing-returns greedy under a duration budget). Used by `sort-reporter`. |
| `coverage-select.unit.spec.ts` | Pure unit tests for the coverage-select helpers (imports `@playwright/test` directly — no app server). |
| `unit-fixtures.ts`      | Lightweight `test`/`expect` for pure unit specs that import `app/` into the Playwright worker. Auto `_workerCoverage` collects inspector precise coverage (no browser / no server) and writes the same per-test Istanbul artifacts as E2E `_coverage`. |
| `login.ts`              | Thin `login(page, user)` helper that fills the real form.     |
| `playwright-mocks/`     | Vendored library: Playwright-shaped `Route`/`ProxyRequest`/`ProxyResponse` facade on top of [`mockttp`](https://github.com/httptoolkit/mockttp), plus the `workerProxy` + `mocks` fixtures consumed via `mergeTests`. See [`playwright-mocks/README.md`](./playwright-mocks/README.md) for the full API. |
| `mockttp-fixture/`      | Sibling library: the bare-minimum mockttp + Playwright integration (`workerProxy` + raw `Mockttp` as `mocks`). Reference artifact for comparison — not consumed by this repo's tests. See [`mockttp-fixture/README.md`](./mockttp-fixture/README.md). |
| `mock-handlers.ts`      | Closure-factory helpers that build reusable `route` handlers (kptncook share/search/images, OpenAI dedup) without registering them — specs hand the returned handler to `mocks.route(...)` themselves. |
| `mock-data.ts`          | Shared test payloads (cinnamon-buns recipe, tiny 1×1 JPEG, kptncook API key). |
| `sort-reporter.ts`      | Custom reporter: always writes `.playwright-data/duration.json` (`testId → ms`). Default `preprocess()` sorts by `test.id`. With `PLAYWRIGHT_DIFF_FILE` + `PLAYWRIGHT_DURATION_BUDGET_MS`, builds a coverage index and excludes/reorders to a budgeted subset. |
| `*.spec.ts`             | Specs. E2E imports `test`/`expect` from `./fixtures`; pure `app/` unit specs use `./unit-fixtures`; tooling-only `*.unit.spec.ts` use `@playwright/test` directly. |

The app's HTTP boundary is the only seam tests use — there's no direct
DB access from the test process. `globalSetup` owns the Postgres
testcontainer and the schema; each Playwright worker owns its own
Vite dev server (with `@netlify/vite-plugin` providing the Blobs/etc.
emulation that we'd otherwise need `netlify dev` for).

## Per-test code coverage

Every test automatically collects frontend (Playwright JSCoverage) and
backend (Node `NODE_V8_COVERAGE` + `SIGUSR2` dump) coverage against the
sourcemapped production build from `globalSetup`. Both sides are merged
(via `istanbul-lib-coverage`) into one Istanbul map keyed by original
`app/` paths, written to
`.playwright-data/coverage/<worker>-<testId>/coverage.json`, and attached on
the test as `coverage` (visible in the HTML report). Remapped hits in
`node_modules` / framework virtual modules are dropped — only `app/**`
is kept. Files with no statement hits are omitted. Before applying V8
ranges, remapping zeroes `v8-to-istanbul`'s default count=1 line state so
incremental `takeCoverage()` dumps (which omit never-run functions) cannot
paint whole sourcemapped modules as covered on load. No env flag, no extra
npm script. Artifacts live under `.playwright-data/` (not `test-results/`)
so they survive Playwright's outputDir wipe at the start of the next run —
required for diff-aware selection in `preprocess`.

Pure unit specs that import `app/` into the Playwright worker (e.g.
`units.spec.ts`) cannot use the E2E `_coverage` fixture — that only sees
browser + `react-router-serve`. Those specs import `test`/`expect` from
`unit-fixtures.ts` instead, which collects **inspector precise coverage**
in the worker and remaps the same way. Tooling-only `*.unit.spec.ts`
files (coverage-select / coverage-remap helpers) stay on raw
`@playwright/test` — they don't hit `app/` and must not boot the server.

The `sort-reporter` also writes `.playwright-data/duration.json` mapping each
`test.id` to its last-run duration in ms.

### Diff-aware selection

`coverage-select.ts` builds an in-memory line→test index from those
Istanbul files and picks an ordered test list under a duration budget
(diminishing returns weighted by line IDF: prefer rare diff lines, then
reinforce). Diff parsing unions **new-side added** lines with **old-side
deleted** lines (so delete-only hunks still resolve against prior coverage).
`sort-reporter` calls it from `preprocess` when both env vars are set:

```bash
# 1) Full run → coverage artifacts + duration.json
npm test

# 2) Budgeted run against a diff (uses prior coverage + durations)
git diff main...HEAD > /tmp/d.diff
PLAYWRIGHT_DIFF_FILE=/tmp/d.diff \
PLAYWRIGHT_DURATION_BUDGET_MS=60000 \
npm test
```

Optional overrides: `PLAYWRIGHT_COVERAGE_DIR` (default
`.playwright-data/coverage`), `PLAYWRIGHT_DURATION_FILE` (default
`.playwright-data/duration.json`). If the duration file or coverage dir is
missing, the reporter warns and falls back to id-sort.

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
npm test                          # the whole suite (sets PLAYWRIGHT_FORCE_ASYNC_LOADER=1)
npx playwright test smoke.spec    # a single file — prefer `npm test -- …` so the env is set
npx playwright test --debug       # step through with the inspector
npx playwright test --ui          # time-travel UI
```

`PLAYWRIGHT_FORCE_ASYNC_LOADER=1` is required on Playwright ≥1.61: the
default sync `registerHooks` loader breaks loading `mockttp` from our
fixtures (`ERR_VM_MODULE_LINK_FAILURE` on `node:net`). Prefer `npm test -- …`
over bare `npx playwright test` so the env is set.

Drop `await page.pause()` anywhere in a spec to freeze the run, open
the inspector, and click around the live app + DB state.

## Reuse mode

For fast local iteration, `globalSetup` labels the testcontainer with
`withReuse()`, so subsequent runs reuse the same Postgres instance.
CI cold-starts.

## Mocking external APIs

The app calls two external services that are mocked: kptncook (recipe
import) and OpenAI (shopping-list dedup). Both are mocked at the HTTP
layer by the vendored **[`playwright-mocks/`](./playwright-mocks/README.md)**
library — a Playwright-shape facade over
[mockttp](https://github.com/httptoolkit/mockttp). The library exposes
its `workerProxy` + `mocks` fixtures, which this repo's
`tests/fixtures.ts` composes with the rest via `mergeTests`. **App
code calls real production URLs** — there is no test-only base-URL
env var or `if (test)` branch in `app/`.

> **Exception — generic recipe import.** The schema.org URL importer
> (`recipe-import-live.spec.ts`, `recipe-import-ui-live.spec.ts`) is
> deliberately **not** mocked: it fetches a handful of real recipe
> pages over the network (unmatched requests fall through the proxy to
> the real internet) and asserts loosely on the result. These specs
> can flake if a third-party page 404s, bot-blocks the CI IP, or
> changes its content — the fix is to swap the URL, not to weaken the
> importer. The SSRF-guard / no-recipe error cases in those specs are
> network-independent (localhost / example.com).

Specs opt in to the test-scoped **`mocks` fixture** and call
`mocks.route(pattern, handler, options?)` directly:

```ts
import { test, expect } from "./fixtures";
import { MOCK_RECIPES } from "./mock-data";
import { kptncookShareRedirectHandler } from "./mock-handlers";

test("import a recipe", async ({ page, flat, mocks }) => {
  await mocks.route(
    /^https:\/\/share\.kptncook\.com\/[^/]+$/,
    kptncookShareRedirectHandler([MOCK_RECIPES.cinnamonBuns]),
  );
  await mocks.route("https://api.openai.com/v1/embeddings", async (route) => {
    await route.fulfill({ status: 200, json: { /* … */ } });
  });
});
```

`mock-handlers.ts` exposes closure factories that return ready-to-use
route callbacks — specs hand them to `mocks.route(...)` themselves so
setup stays local to the test.

The proxy fixture clears routes + listeners on teardown, so handlers
never leak between tests on the same worker. Unmatched requests fall
through to a real-network passthrough.

**See [`playwright-mocks/README.md`](./playwright-mocks/README.md)
for the full API** — `Route` methods, events, `waitForRequest` /
`waitForResponse`, handler chains, `{ times }`, glob syntax, and the
gaps vs Playwright.


