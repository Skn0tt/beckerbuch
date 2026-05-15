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
  `loginAs`, no `storageState`. See [`tests/README.md`](./tests/README.md).
- **Schema changes**: edit `app/db/schema.ts`, then `npm run db:generate`
  to produce a new file in `drizzle/`. Commit both.
- **Style**: Prettier + ESLint defaults. Don't add comments that
  restate code; comment intent / non-obvious decisions only.

## Stack at a glance

React Router 7 + TypeScript, Mantine, Drizzle + `pg`, argon2id,
Postgres 16 (Testcontainers in tests, Neon in prod), Netlify Functions,
Playwright E2E.
