# tests/

Playwright end-to-end tests. Real app, real Postgres, real session
cookies. See [TECH.md §10](../TECH.md) for the full testing model.

## Layout

| File                    | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `fixtures.ts`           | Playwright `test` extended with the `flat` fixture (opt-in: ask for it via `({ flat }) => …`). Also exports `generateInvite(page, user)` for tests that need an invite URL — it logs the user in, drives the `/flat/settings` UI, and returns the freshly minted link. The `flat` fixture provisions a flat via the admin endpoint, then redeems the bootstrap invite via the public form to mint a real first user. |
| `login.ts`              | Thin `login(page, user)` helper that fills the real form.     |
| `proxy/`                | Mock HTTP(S) proxy for the app's outbound calls (kptncook, OpenAI). See [Mocking external APIs](#mocking-external-apis) below. |
| `*.spec.ts`             | Specs. Import `test`/`expect` from `./fixtures`.              |

The app's HTTP boundary is the only seam tests use — there's no direct
DB access from the test process. The dev server, started by `dev.mjs`,
owns the Postgres testcontainer and the schema.

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
  construction. Playwright picks the worker count automatically
  (typically 6 on a modern laptop), giving roughly a 2× speedup over
  serial. No `retries`: if a test fails it's a real bug, not a flake.

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

For fast local iteration, the `dev.mjs` orchestrator labels its
testcontainer with `withReuse()`, so subsequent runs reuse the same
Postgres instance. CI cold-starts.

## Mocking external APIs

The app calls two external services: kptncook (recipe import) and
OpenAI (shopping-list dedup). Both are mocked at the HTTP layer by a
[mockttp](https://github.com/httptoolkit/mockttp) proxy that `dev.mjs`
starts alongside the testcontainer. The netlify-dev child gets
`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` + `NODE_EXTRA_CA_CERTS` set on
its env, so Node's global `fetch` natively routes through the proxy
and trusts its generated CA. **App code calls real production URLs**
(`https://mobile.kptncook.com`, `https://api.openai.com`, …) — there
is no test-only base-URL env var or `if (test)` branch in `app/`.

Layout under `tests/proxy/`:

| File                    | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `server.mjs`            | `startMockProxy()` — boots mockttp, registers handlers, returns `{url, proxyEnv, stop}`. Unmatched requests get a 502 with a diagnostic message so a missing handler fails loudly instead of silently hitting the real internet. |
| `fixtures.mjs`          | Shared test payloads (the cinnamon-buns kptncook recipe, the tiny 1×1 JPEG, the kptncook API key the handler accepts). Imported by both handlers and specs. |
| `handlers/kptncook.mjs` | Mocks `share.kptncook.com` + `mobile.kptncook.com`.         |
| `handlers/openai.mjs`   | Mocks `api.openai.com/v1/chat/completions`. Mirrors the dedup grouping (lowercased item, trailing `s` stripped). Exports `DEDUP_FAILURE_TRIGGER` — name an ingredient with that magic string in a spec to force a 500 and exercise the LLM-failure fallback. |

To mock a new external API, drop a `handlers/<name>.mjs` exporting a
`register*(server)` function and call it from `server.mjs`. No app-code
changes required.
