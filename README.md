# cookbook

A recipe collection + shopping-list planner for our flat. Plan a week's
meals from your saved recipes, finalise the draft into one combined
shopping list, hand off to the **Bring!** app for the actual shop, then
work through the in-stock board as you cook.

See [`DESIGN.md`](./DESIGN.md) for the product story,
[`UI.md`](./UI.md) for screens, [`TECH.md`](./TECH.md) for architecture,
and [`PHASES.md`](./PHASES.md) for the (mostly completed) build plan.

## Quickstart

You need **Node ≥ 22.16** and a running **Docker daemon** (Docker Desktop,
Colima, OrbStack — anything that exposes a Docker socket Testcontainers
can find).

```bash
git clone …
cd beckerbuch   # or whatever you named the clone
npm install
npm test
```

That's it. `npm test` boots a `pgvector/pgvector:pg16` container via
Testcontainers, applies the schema, builds the app, starts a per-worker
`react-router-serve` process, and runs the Playwright suite. There is no
`npm run dev` — see [TECH.md §11](./TECH.md) for why and how to drive the
app interactively through Playwright instead.

## Scripts

| Script                | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `npm test`            | Whole loop: container + schema + app + Playwright            |
| `npm run db:generate` | `drizzle-kit generate` — diff schema → SQL migration file    |
| `npm run lint`        | ESLint + `tsc --noEmit` (typecheck is part of lint)          |
| `npm run build`       | Production build (used by Netlify)                           |

For visual debugging, use Playwright's CLI flags directly:
`npx playwright test --debug`, `--ui`, `--headed`, or sprinkle
`await page.pause()` in a spec. For the AI/`playwright-cli` attach
flow, see [`AGENTS.md`](./AGENTS.md).

## Connecting ChatGPT (MCP)

Kochbuch exposes a small MCP server at `/mcp` so ChatGPT (and other
MCP clients) can add recipes on your behalf. It speaks **Streamable
HTTP** with **OAuth 2.1 + PKCE** and **Dynamic Client Registration**
(RFC 7591) — the standard remote-connector flow.

In ChatGPT, add a **custom connector** pointing at
`https://<your-deployment>/mcp`. ChatGPT will discover the OAuth
configuration via `/.well-known/oauth-protected-resource`, register
itself, and walk you through the consent screen (you'll need to be
signed in to your flat first). After approval it can call:

- `kochbuch_add_recipe` — name, baseQuantity, ingredients, steps,
  optional sourceUrl, optional photoUrl (server fetches the image)
- `kochbuch_search_recipes` — free-text search over the flat's collection
- `kochbuch_get_recipe` — fetch one recipe by id
- `kochbuch_edit_recipe` — patch name / quantities / ingredients / steps
- `fetch_recipe` — resolve a URL / kptncook id into a normalized payload
  (does not store; pass the result to `kochbuch_add_recipe` to save)
