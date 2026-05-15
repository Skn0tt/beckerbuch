# tests/

Playwright end-to-end tests. Real app, real Postgres, real session
cookies. See [TECH.md §10](../TECH.md) for the full testing model.

## Layout

| File                    | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `fixtures.ts`           | Playwright `test` extended with the `flat` fixture (opt-in: ask for it via `({ flat }) => …`). Also exports `generateInvite(page, user)` for tests that need an invite URL — it logs the user in, drives the `/flat/settings` UI, and returns the freshly minted link. The `flat` fixture provisions a flat via the admin endpoint, then redeems the bootstrap invite via the public form to mint a real first user. |
| `login.ts`              | Thin `login(page, user)` helper that fills the real form.     |
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
- `fullyParallel: true` from the start — per-test flats make
  parallelism safe by construction.

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
