# AGENTS.md

Guide for AI coding assistants (Copilot CLI, Claude Code, Cursor, etc.)
working on **cookbook**. Read this first.

## Source-of-truth docs

Read in this order before changing anything non-trivial:

1. [`DESIGN.md`](./DESIGN.md) — product story, glossary, what we're
   building and (importantly) what we're *not* building in v1.
2. [`UI.md`](./UI.md) — ASCII wireframes per screen, desktop vs mobile.
3. [`TECH.md`](./TECH.md) — stack, schema, auth, search, testing,
   deployment.
4. [`PHASES.md`](./PHASES.md) — build order. Don't skip ahead.

If a doc contradicts the code: fix the doc. Docs are living.

## Hard rules

### 1. Use the `playwright-cli` skill for browser interactions

Whenever you need to drive a browser — exploring the running app,
debugging a failing spec, taking a screenshot, manually walking
through a flow — invoke the **`playwright-cli`** skill / MCP tool.

**Do NOT:**
- spawn raw browsers (`open`, `chromium`, `puppeteer`, etc.)
- write throwaway Node scripts that import `playwright` directly
  outside of `tests/`
- shell out to `npx playwright codegen` from arbitrary scripts

This keeps human and AI workflows symmetric (everyone drives the
same way) and prevents "AI wrote a browser script that doesn't match
the test rig" drift.

#### Showing the user a screenshot for UI review

Drive the **real Playwright test** (so you get the real container,
real tenant, real auth, real dev server — same env as CI) and attach
to its paused session with `playwright-cli`:

1. Write or pick a spec that reaches the state you want to show. If
   it doesn't already exist, drop `await page.pause()` at the moment
   to capture, or just rely on the implicit pause `--debug` adds.
2. Launch the test in debug-cli mode:
   ```bash
   npm test -- --debug=cli            # whole suite
   npm test -- --debug=cli foo.spec   # one file
   ```
3. The runner prints a session id like `tw-f4a5f7` and the line
   `Run "playwright-cli attach tw-f4a5f7" to attach to this test`.
4. In a separate shell, attach and drive:
   ```bash
   playwright-cli attach tw-f4a5f7
   playwright-cli --s=tw-f4a5f7 step-over     # advance a step
   playwright-cli --s=tw-f4a5f7 resize 1280 800
   playwright-cli --s=tw-f4a5f7 screenshot
   ```
   `--s=<session>` is required on every follow-up command; the
   session is per-test, not global. Use `resize 390 844` for the
   iPhone-14 mobile viewport.
5. The screenshot lands in `.playwright-cli/page-*.png`. Open it
   with the `view` tool — Copilot CLI renders images inline so the
   user sees it in your reply.
6. For interactive UI review, hand the page to the user via
   `playwright-cli -s=<session> show --annotate` — see below.
7. `playwright-cli --s=<session> resume` to let the test finish, or
   just close the runner shell.

**Why this and not `npm run dev` + `playwright-cli open`:** there
is no `dev` script — by design — and even if you spin up
`netlify dev` by hand you'd be looking at an empty database with no
tenant and no logged-in user. `--debug=cli` reuses the test's
fixtures (tenant, login) so the screenshot reflects the same state
the test asserts on.

#### Asking for a UI review

Once you've stepped to the right state in the attached test session,
hand the page over to the user with the Playwright Dashboard's
**annotation mode**:

```bash
playwright-cli -s=<session> show --annotate
```

This blocks until the user closes the dashboard. They circle
regions on the live page and type comments on each one. When they
finish, the command returns:

- a structured list of annotations (rect coords + comment) printed
  to stdout, e.g. `{ x: 281, y: 28, width: 202, height: 102 }: tighten this margin`
- an annotated PNG at `.playwright-cli/annotations-*.png` showing
  the page with the user's rectangles and labels burned in

Read both, then act on the comments. View the PNG with `view` so
you can refer back to what the user circled.

If the user gives no annotations and just closes the dashboard,
treat that as "no comments — ship it."

Prefer `show --annotate` over a freeform `ask_user` form for visual
review: the user can point at things directly instead of describing
them in prose.

### 2. Never `git commit` without explicit user go-ahead

Even for "obvious" changes. Summarise the diff, suggest a commit
message, then wait for an explicit "commit" / "ship it" / "lgtm".

### 3. Verify by running tests

A change isn't done until `npm test` is green. Type-check and lint
are baseline, not verification. If you can't run tests for a
genuine reason (e.g. Docker isn't running), say so explicitly
rather than skipping.

### 4. Commit trailer

Every commit ends with:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Conventions

- **Four npm scripts only**: `test`, `db:generate`, `lint`, `build`.
  Don't add aliases like `dev`, `typecheck`, `db:push`. For Playwright
  variants, invoke the CLI directly (`npx playwright test --debug`).
- **No test-only code in the app**: no `/_test/*` routes, no
  `loginAs`, no `storageState`, no `if (test)` branches, no
  `*_BASE_URL` env-var seams. External APIs (kptncook, OpenAI) are
  mocked at the HTTP layer by the proxy in `tests/proxy/`; the app
  code calls real production URLs. The generic schema.org URL importer
  is the one deliberately-unmocked exception — its specs hit real
  recipe pages (see [`tests/README.md`](./tests/README.md)).
- **Schema changes**: edit `app/db/schema.ts`, then `npm run db:generate`
  to produce a new file in `drizzle/`. Commit both.
- **Style**: Prettier + ESLint defaults. Don't add comments that
  restate code; comment intent / non-obvious decisions only.

## Stack at a glance

React Router 7 + TypeScript, Mantine, Drizzle + `pg`, argon2id,
Postgres 16 (Testcontainers in tests, Neon in prod), Netlify Functions,
Playwright E2E.
