# tests/

Playwright end-to-end tests. Real app, real Postgres, real session
cookies. See [TECH.md §10](../TECH.md) for the full testing model.

## Layout

| File                    | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `global-setup.ts`       | Boots `postgres:16` via Testcontainers, applies the schema, sets `DATABASE_URL`. Returns its own teardown function (no separate `global-teardown.ts`). |
| `db.ts`                 | Lazy `pg` pool + Drizzle client — used by fixtures only.      |
| `tenant.ts`             | `createTenant()` provisions a fresh user + flat with a random email. Argon2 hash is computed once at module load and shared. |
| `fixtures.ts`           | Playwright `test` extended with the `tenant` fixture (opt-in: ask for it via `({ tenant }) => …`). |
| `login.ts`              | Thin `login(page, user)` helper that fills the real form.     |
| `*.spec.ts`             | Specs. Import `test`/`expect` from `./fixtures`.              |

## Conventions

- **Each test gets its own tenant**, not a shared seed. We rely on
  multi-tenancy (one user, one flat per test) for isolation rather
  than truncating tables. No global reset.
- **Tests act like real users.** No `/_test/*` routes, no `loginAs`
  shortcut, no `mintSession`, no `storageState`. The `login()` helper
  fills the actual form.
- **Test-only setup that can't go through the UI** (creating tenants)
  lives here in `tests/`, importing `app/db/schema` directly. The app
  itself has zero awareness it's running under tests.
- `fullyParallel: true` from the start — per-test tenants make
  parallelism safe by construction. Playwright picks the worker
  count automatically based on the suite size.

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

For fast local iteration, set `TESTCONTAINERS_REUSE_ENABLE=true` to
keep the Postgres container alive between runs. The teardown is
skipped; subsequent runs reuse the container (still resetting the
data per-test). CI always cold-starts.
