# cookbook

A recipe collection + shopping-list planner for our flat. Plan a week's
meals from your saved recipes, finalise the draft into one combined
shopping list, hand off to the **Bring!** app for the actual shop, then
work through the in-stock board as you cook.

See [`DESIGN.md`](./DESIGN.md) for the product story,
[`UI.md`](./UI.md) for screens, [`TECH.md`](./TECH.md) for architecture,
and [`PHASES.md`](./PHASES.md) for the build plan.

## Quickstart

You need **Node 22+** and a running **Docker daemon** (Docker Desktop,
Colima, OrbStack — anything that exposes a Docker socket Testcontainers
can find).

```bash
git clone …
cd kochbuch
npm install
npm test
```

That's it. `npm test` boots a `postgres:16` container via Testcontainers,
applies the schema, starts the app via `netlify dev`, and runs the
Playwright suite. There is no `npm run dev` — see [TECH.md §11](./TECH.md)
for why and how to drive the app interactively through Playwright instead.

## Scripts

| Script                | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `npm test`            | Whole loop: container + schema + app + Playwright            |
| `npm run db:generate` | `drizzle-kit generate` — diff schema → SQL migration file    |
| `npm run lint`        | ESLint + `tsc --noEmit` (typecheck is part of lint)          |
| `npm run build`       | Production build (used by Netlify)                           |

For visual debugging, use Playwright's CLI flags directly:
`npx playwright test --debug`, `--ui`, `--headed`, or sprinkle
`await page.pause()` in a spec.

## Connecting ChatGPT (MCP)

Kochbuch exposes a small MCP server at `/mcp` so ChatGPT (and other
MCP clients) can add recipes on your behalf. It speaks **Streamable
HTTP** and authenticates with a **per-user long-lived token** in the
URL — no OAuth flow.

Open **Flat settings** in the UI and copy the MCP URL it shows
(`https://<your-deployment>/mcp?token=<uuid>`). Paste that URL into
your MCP client as a custom connector. The same UUID is also accepted
via `Authorization: Bearer <uuid>` for clients that prefer header
auth. After connecting, the client can call:

- `kochbuch_add_recipe` — name, baseQuantity, ingredients, steps,
  optional sourceUrl, optional photoUrl (server fetches the image)

