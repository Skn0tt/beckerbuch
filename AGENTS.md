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

### 2. Deliver screenshots as proof for UI changes

Any change that affects the UI is not done until you show the user
**screenshots as proof**. Don't just claim it works — prove it
visually. Capture the before/after (or the new state) using the
`playwright-cli` `--debug=cli` flow documented in rule 1 (real
container, real tenant, real auth), and open each PNG with the `view`
tool so it renders inline in your reply.

Cover the states that matter for the change — e.g. a new button in its
resting state, any modal/confirmation it opens, and the resulting state
after the action. If a change is genuinely non-visual (pure
server/schema/refactor with no rendered difference), say so explicitly
instead of skipping silently.

### 3. Never `git commit` without explicit user go-ahead

Even for "obvious" changes. Summarise the diff, suggest a commit
message, then wait for an explicit "commit" / "ship it" / "lgtm".

### 4. Verify by running tests

A change isn't done until `npm test` is green. Type-check and lint
are baseline, not verification. If you can't run tests for a
genuine reason (e.g. Docker isn't running), say so explicitly
rather than skipping.

### 5. Commit trailer

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

## Cursor Cloud specific instructions

Dependencies (`npm install`, Playwright's chromium browser, Docker + the
`pgvector/pgvector:pg16` image) are already installed by the environment's
update script. The two things below are *not* automatic and bite every
fresh session — handle them before running `npm test`.

### 1. Use Node ≥ 22.16 (nvm provides v22.22.2 in login shells)

`npm test` must run under Node **≥ 22.16**. The mock proxy
(`tests/playwright-mocks/`) routes the app's outbound HTTPS through mockttp
by setting `NODE_USE_ENV_PROXY=1` on the `react-router-serve` child — a
feature only present from Node 22.16. Under an older Node the app ignores
the proxy and hits the real internet, so any spec that mocks an upstream
fails with real-API errors (e.g. Gemini `HTTP 403 Forbidden` in
`handoff-dedup`/`planned-ingredients`, kptncook import failures).

- A **login / tmux shell** sources `~/.bashrc` → nvm → Node **v22.22.2**,
  which is correct. The tmux workflow in the cloud guidance already does
  this.
- The non-login shell used by one-off command runners defaults to an older
  pinned Node (v22.14.0). If `npm test` shows the dedup/kptncook failures
  above, check `node -v` first — that's almost always the cause. Prefix a
  run with `export PATH="$HOME/.nvm/versions/node/$(nvm version default)/bin:$PATH"`
  or run inside a tmux login shell.

### 2. Start the Docker daemon first (Testcontainers)

`npm test` boots Postgres via Testcontainers, so a Docker daemon must be
running. It is installed but not auto-started. Start it once per session:

```bash
sudo dockerd > /tmp/dockerd.log 2>&1 &
```

`/etc/docker/daemon.json` is already configured for this VM
(`fuse-overlayfs` storage driver + `containerd-snapshotter` disabled, which
Docker 29 needs for fuse-overlayfs). The `pgvector/pgvector:pg16` image is
pre-pulled. Tests use `withReuse()`, so the container survives across runs;
exporting `TESTCONTAINERS_REUSE_ENABLE=true` speeds up local iteration.

### Poking at a running instance (no dev server)

There is no `npm run dev`; the E2E suite is the inner loop. The easiest way
to reach a running, seeded, logged-in instance is to start a test and step
to the end of it rather than booting the app by hand — the test fixtures
give you a real Postgres container, a tenant, and an authenticated session
for free. Use the `--debug=cli` + `playwright-cli attach` flow already
documented in **rule 1** above (and [TECH.md §11.1](./TECH.md)):

```bash
npm test -- --debug=cli some.spec   # prints a session id to attach to
```

Then `playwright-cli attach <id>`, `step-over` to the state you want, and
`screenshot`. Prefer this over manually running
`react-router-serve` — that path leaves you with an empty DB, no tenant, and
no session.
