# Implementation phases

DESIGN.md, UI.md, TECH.md are committed. This file plans the build.

## Locked-in constraints

1. **Phase 1 is a sign-off gate.** No feature work starts until the
   testing setup is reviewed and approved.
2. **No dev mode in v1.** The primary developer interaction is
   writing and running E2E tests. Visual debugging via
   `npm run test:debug`, `npm run test:ui`, or `await page.pause()`.
3. **Postgres is launched by Playwright via Testcontainers** — no
   `docker-compose.yml`, no orchestration script.
4. **No test-only code in the app, no auth shortcuts.** Tests act
   like real users: every spec fills the login form at start via a
   thin `login(page, user)` helper. Setup that can't be done through
   the UI (DB reset, seeding) goes through direct Drizzle access
   from the test process. No `/_test/*` routes, no `loginAs` /
   `mintSession` shortcut, no `storageState` machinery.

These constraints simplify the surface drastically. TECH.md §1,
§10, §11, §11.2 will need a follow-up rewrite to match — captured
as Phase 1.10.

## Stack reminder

(locked in TECH.md, with rewrite pending in 1.10)

- React Router v7 + TypeScript, SSR
- Mantine (`@mantine/core`, `@mantine/form`, `@mantine/notifications`, `@mantine/dnd`)
- Postgres 16 — **launched by Testcontainers in Playwright globalSetup** locally and in CI
- Drizzle + `pg`
- argon2id + signed cookie sessions, no expiry
- Netlify Functions (not Edge), Netlify Blobs
- Playwright E2E only, no unit tests

## Phase 1 — Foundations & test harness (sign-off gate)

**Goal:** scaffold the app + put the testing rig in place. End
state: `npm test` brings up a fresh Postgres container, applies
schema, runs a smoke spec that logs in via the real form and
asserts the empty-state. Green means ready for Phase 2.

### 1.1 Scaffold RR7 app

- `npm create react-router@latest .` (TypeScript, no template extras)
- Add Mantine, Drizzle + drizzle-kit, `pg`, `argon2`, `zod`,
  `@netlify/plugin-react-router`
- `app/root.tsx` wraps in `<MantineProvider>` + `<Notifications>`
- Strict TS, ESLint, Prettier

### 1.2 Testcontainers for Postgres

- Add deps: `testcontainers`, `@testcontainers/postgresql`
- No `docker-compose.yml`. Container is owned by the test process.
- `.env.test` committed with non-DB defaults only:
  - `SESSION_SECRET=test-only-not-a-secret`
  - `NODE_ENV=test`
- `DATABASE_URL` is set dynamically by globalSetup (1.3).

### 1.3 `tests/global-setup.ts` — owns the database lifecycle

- `new PostgreSqlContainer("postgres:16")` pinned
- Init script enables `pgcrypto`, `pg_trgm`, `unaccent`
- Wait for ready → set `process.env.DATABASE_URL`
- Run `drizzle-kit push` (apply schema)
- Save the container handle for `global-teardown.ts`
- **No browser launch, no auth dance.** Per-test fixtures handle
  user seeding and login.
- **Reuse mode**: `TESTCONTAINERS_REUSE_ENABLE=true` honoured for
  local fast iteration; CI always cold-starts.

### 1.4 First migration: full schema

- Implement TECH.md §3 in `app/db/schema.ts`: users, flats,
  flat_members, sessions, invites, recipes, ingredients,
  recipe_instances. Indexes per §3.3, §5.1.
- `drizzle-kit generate` → `drizzle/0000_init.sql` (committed).

### 1.5 Test fixtures + `login()` helper

`tests/fixtures.ts`, `tests/seed.ts`, `tests/login.ts`.

- No `/_test/*` routes. The test process owns its own `pg` pool
  and imports `app/db/schema.ts` directly.
- Auto-fixture `resetDb`:
  1. `TRUNCATE … CASCADE` of every app table
  2. Insert one default flat + at least one default user
     (`demo@cookbook.local` / password `cookbook`). Returns the
     IDs.
- Helper `seed(payload)`: typed Drizzle inserts for additional
  users / recipes / ingredients / instances. Returns IDs.
- Helper `login(page, { email, password } = defaultUser)`:
  ```ts
  await page.goto('/login');
  await page.fill('[name=email]', email);
  await page.fill('[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL('/');
  ```
  Convenience only — does the same thing the user would.

### 1.6 Playwright config + smoke spec

- `playwright.config.ts`:
  - `globalSetup: ./tests/global-setup.ts`
  - `globalTeardown: ./tests/global-teardown.ts`
  - `webServer`: `netlify dev` with `.env.test` loaded;
    `DATABASE_URL` already in `process.env` from globalSetup
  - `baseURL: http://localhost:8888`
  - **No `storageState`** — every test starts fresh
  - `fullyParallel: false` for v1 (single shared container)
- `tests/smoke.spec.ts`:
  1. (auto) `resetDb` → seed user/flat exist
  2. `await login(page)`
  3. visit `/`
  4. expect "No recipes yet" empty state

### 1.7 Login spec

`tests/login.spec.ts` — a regular spec that drives the form
directly (doesn't use the `login()` helper, since it's testing the
form itself). Covers happy path, wrong password,
redirect-after-login. Login is also exercised at the top of every
other spec via `login(page)`, so any regression breaks the whole
run loudly.

### 1.8 npm scripts

Four total — that's it.

- `test` → `playwright test` (use Playwright's own CLI flags
  `--headed`, `--debug`, `--ui` directly when needed; no aliases)
- `db:generate` → `drizzle-kit generate`
- `lint` → ESLint **plus** `tsc --noEmit` (typecheck is part of
  lint, not a separate script)
- `build`

### 1.9 CI

- `.github/workflows/ci.yml`: Node 22, `npm ci`, `npm run lint`
  (which includes typecheck), `npx playwright install --with-deps chromium`,
  `npm test`.
- No Postgres `services:` block — Testcontainers handles it.
- Neon-branch-per-PR (TECH.md §10) deferred to Phase 6.

### 1.10 Update TECH.md

✅ **Already done** in the cross-doc drift-resolution pass that
preceded Phase 1 implementation. Specifically:

- §1 stack table: DB row split (Neon prod / Testcontainers test);
  added "Test runtime" row; CI row reads "lint (eslint + tsc) +
  Playwright".
- §10 Testing rewritten end-to-end (Testcontainers + direct-DB
  fixtures + real-form `login()` helper; no storageState, no test
  routes, no shortcuts; coverage targets fixed).
- §11 rewritten as "Local development = the E2E loop" — no dev
  mode, four scripts only, Playwright CLI for visual exploration.
- §11.2 (parity) now points at Testcontainers as the local
  mechanism; Neon-branch parity is documented as the Phase 6 add.
- §13 carries the Phase 6 deferral entry for the Neon-branch CI
  job.

If new drift creeps in during Phase 1 implementation, fix it as
part of the relevant task rather than batching here.

### 1.11 Docs

- README.md two-command quickstart: `npm install && npm test`
  (only requires Docker daemon).
- `tests/README.md` walking through fixtures + the `login()`
  helper convention.

### 1.12 `AGENTS.md` (AI-assistant guide)

Conventional file that AI coding assistants (Claude Code, Copilot
CLI, Cursor, etc.) read on session start. Tool-agnostic name; if a
specific tool needs `CLAUDE.md` instead, symlink it.

Must include, at minimum:

- **Use the `playwright-cli` skill / MCP for any browser
  interaction.** Never spawn raw browsers, never write Node scripts
  that call Playwright's API directly outside of `tests/` — drive
  the browser through the skill. This keeps human and AI workflows
  symmetric and avoids drift.
- The four-script convention (1.8) and the testing model (1.5–1.7).
- Commit hygiene: include the `Co-authored-by: Copilot` trailer on
  every commit; never run `git commit` without explicit approval.
- Verification rule: a change isn't done until `npm test` is green.
- Pointers to DESIGN.md (product), UI.md (screens), TECH.md
  (architecture), and this file (phases).

🛑 **STOP — wait for sign-off on the testing setup before Phase 2.**

## Phase 2 — Auth & user management

End state: real signup/login/logout, invites, flat settings screen,
all covered by E2E.

- argon2id password hashing util (TECH.md §4.1)
- `requireSession` loader middleware (§4.2)
- Routes: `/login`, `/logout`, `/invite/:token`
- Flat settings page with member list + invite generation
- E2Es: login happy + sad paths (`login.spec.ts` from 1.7
  expanded), signup via invite, invite-token wrong/used, sign-out,
  flat settings rename

## Phase 3 — Recipe CRUD & collection

- Workspace shell: desktop two-pane, mobile bottom-tab nav
- Recipe list (UI.md §2): card grid, empty state, search bar
- Recipe view (UI.md §3)
- Recipe edit form (UI.md §4) — `@mantine/form` + zod
- Photo upload to Netlify Blobs (filesystem-emulated locally)
- Postgres FTS index + `pg_trgm` per TECH.md §5
- E2Es: create with photo, edit, delete (blocked when in any
  recipe_instance), search by name / ingredient / source-host /
  step

## Phase 4 — Draft & in-stock

- Draft sidebar (desktop) + Mobile Kitchen tab (UI.md §5, §6)
- Add to draft from recipe view
- Target-quantity stepper (live ingredient scaling preview)
- Designated cook picker
- Reorder via `@mantine/dnd` in both lanes
- Mark cooked / remove from stock
- E2Es: add to draft, scale qty, reorder, cook, remove

## Phase 5 — Finalise & Bring! handoff

- `/draft/finalise` action: single UPDATE per TECH.md §7
- Finalise confirmation modal (UI.md §7)
- Public `/r/:id` page emitting schema.org Recipe JSON-LD with
  optional `?q=` scaling
- Public `/h/:flatId` handoff page, responsive (UI.md §8)
- E2Es: finalise empty draft (blocked), finalise with items,
  handoff renders both modes, JSON-LD validates, Bring! deep link
  resolves

## Phase 6 — Polish, deploy, parity safety net

- Notifications wiring throughout (Mantine)
- Error boundaries + 404
- Netlify production config: `netlify.toml`, env vars in UI, build
  command runs migrations
- Hook up Neon DB (production) + Netlify Blobs (production)
- Add CI step: ephemeral Neon branch per PR, run Playwright against
  it (TECH.md §10 parity safety net)
- Manual deploy + smoke check
- Hand off

## Notes

- **Why no `/_test/*` routes**: keeps production builds free of
  any test-shaped code or runtime gates. Cost: test process needs
  its own `pg` pool and imports app modules — fine, same repo.
- **Why no auth shortcut and no storageState**: the app is fast
  and the login form takes ~50-100ms to fill and submit. Per-test
  real login keeps every spec self-contained, makes multi-user
  scenarios trivial (`login(page, otherUser)`), and means any
  auth regression fails loudly across the whole suite. Zero setup
  machinery to maintain.
- **`login()` is a typing convenience, not a shortcut**: it does
  exactly what a user would. If we later need to test "user is
  shown 'Welcome back, Tom' on second login", we don't even use
  the helper — we drive the form directly.
- **Visual exploration paths**:
  - `npm run test:debug` — Playwright stepping
  - `npm run test:ui` — time-travel UI
  - `await page.pause()` in any spec — full app loaded & seeded,
    container alive; click around freely
- **DB reset between specs** = `TRUNCATE … CASCADE` + re-insert
  the default flat/user. Container is reused across specs in a
  single `npm test` run.
- **`fullyParallel: false`** in v1 is a deliberate simplification:
  ~30-50 specs, one shared container. If runtime ever bites,
  switch to a container-per-worker (Testcontainers makes this
  trivial).
