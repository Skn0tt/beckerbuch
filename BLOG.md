# Spec-driven Playwright testing with `playwright-cli`

We've [written before](https://dev.to/playwright/playwright-agents-planner-generator-and-healer-in-action-5ajh)
about the plan → generate → heal loop. This post is a short follow-up:
a single concrete example using `playwright-cli` against a third-party
page we don't control, where the *brittleness* of the test is actually
the point.

---

## Setup

You need two things:

- **The CLI** — `npm install -g @playwright/cli@latest`. See the
  [`playwright-cli` docs](https://playwright.dev/docs/playwright-cli)
  for the full surface; for our purposes, every command it runs also
  prints the equivalent Playwright TypeScript.
- **The skill** — the agent playbook that teaches Claude Code, Copilot
  CLI, Cursor (or anything else that supports skills) *how* to use the
  CLI for plan / generate / heal. Drop it into your repo and you're
  done.

---

## A worked example: a recipe importer

Imagine we just shipped a feature in our cookbook app: paste a recipe
URL from somewhere on the web — BBC Good Food, Chefkoch, an old food
blog — and the app fetches the page, parses its
[schema.org Recipe](https://schema.org/Recipe) JSON-LD, and prefills a
new recipe form. We want tests, but we *really* don't want to spend a
day writing brittle selectors today and rewriting them in three months.

Spec-driven testing fits the shape of this feature perfectly. Let's
walk through it.

---

## Step 1 — Generate the spec

We open our agent and paste:

> Use the `playwright-cli` skill to explore the recipe-import feature
> and produce a spec file under `specs/recipe-import.plan.md`. Include
> a scenario that imports
> `https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese`
> and asserts the parsed ingredients exactly (amount, unit, item).

The agent launches a debug session, attaches with `playwright-cli`,
clicks through the importer the way a user would, and writes a spec
file like this:

```markdown
# Recipe Import Test Plan

## Application Overview
The importer accepts a recipe URL, fetches the page, parses its
schema.org Recipe metadata, and prefills the new-recipe form.

## Test Scenarios

### 1. Generic web import

**Seed:** `tests/fixtures.ts` (logged-in user, empty recipe list)

#### 1.1 bbc-good-food-exact-ingredients
**File:** `tests/recipe-import/bbc-good-food-exact-ingredients.spec.ts`
**Steps:**
  1. Open the importer and paste
     `https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese`.
    - expect: the ingredients table contains, in order:
      4 tbsp olive oil; 2 red onions; 2 garlic cloves; ...
```

That file lives in the repo, gets reviewed in PRs, and reads like a
test plan a human wrote on a Monday morning — because functionally,
that's what it is. The agent just typed it for us.

---

## Step 2 — Generate the test

Now the second prompt:

> Generate Playwright tests for scenario 1.1 of
> `specs/recipe-import.plan.md` using the `playwright-cli` skill.

The agent reattaches to a debug session, walks the spec's steps in the
real browser, and produces a `*.spec.ts` file:

```ts
// spec: specs/recipe-import.plan.md scenario 1.1
import { test, expect } from "./fixtures";

test.describe("Generic web import", () => {
  test("bbc-good-food-exact-ingredients", async ({ page }) => {
    // 1. Open the importer and paste the URL.
    await page.getByRole("button", { name: "New recipe" }).click();
    await page.getByRole("button", { name: "Import from URL" }).click();
    await page
      .getByRole("textbox", { name: "Recipe URL" })
      .fill("https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese");
    await page.getByRole("button", { name: "Import" }).click();

    // - expect: the ingredients table contains, in order: ...
    await expect(page.getByRole("table", { name: "Ingredients" }))
      .toMatchAriaSnapshot(`
        - row:
          - cell "4"
          - cell "tbsp"
          - cell "olive oil"
        - row:
          - cell "2"
          - cell
          - cell "red onions"
        # ... and so on for every ingredient
      `);
  });
});
```

Two things worth noting:

- The `// spec:` header at the top of the file is the link back to the
  plan. When this test fails later, you (or your agent) know exactly
  which scenario to reconcile against.
- The assertion is an *aria snapshot* of the whole table. That's
  deliberate: one assertion, the full structure, a single readable
  diff when something drifts.

---

## Step 3 — A few days later, CI goes red

A note before the failure: we deliberately did *not* mock
`bbcgoodfood.com` here. The whole point of the importer is to parse
real third-party pages — if BBC ever changes the shape of their
JSON-LD, our users will hit "Import" and get garbage. We want to know
the day that happens, not three weeks later. Hitting the real URL from
CI is the early-warning system.

One morning, it pings:

```diff
  - row:
    - cell "200"
    - cell "g"
-   - cell "young goat's cheese"
+   - cell "mature goat's cheese"
```

Honestly? This one's noise. We wanted the test to catch BBC changing
the *format* of their data; what we actually caught is BBC changing
the *content* of one recipe. The nice thing is that with the agent in
the loop, noise like this is essentially free to clean up.

---

## Step 4 — Heal

We hand the failure to the agent:

> This test is failing. Use the `playwright-cli` skill to debug it,
> decide whether the spec or the parser is the source of truth, and
> update whichever is wrong.

The agent runs the failing test with `--debug=cli`, attaches, inspects
the live page, sees that the new ingredient name is genuinely what BBC
serves now, and concludes: *spec is stale, parser is fine*. It edits
**both** the spec (`young goat's cheese` → `mature goat's cheese`) and
the test's aria snapshot to match, in one shot. The `// spec:` header
made the round-trip mechanical.

If instead the page was unchanged but our parser had regressed (say,
we dropped the "g" unit somewhere), the agent would do the opposite —
keep the spec, fix the parser. Either way the spec stays honest about
what the app is supposed to do, and the fix has a paper trail.

---

## Why this pays off

A few things change once spec-driven testing is in your loop:

- **Tests stop being write-only.** A failure isn't a mystery — there's
  a plan describing what the test was for.
- **Plans are reviewable on their own.** A PR that adds a feature can
  include a `plan.md` change; reviewers can sign off on *what we
  intend to test* before any selector is written.
- **Healing has receipts.** A locator drift fix and a deliberate
  behaviour change look very different in a `git diff` of the spec.
- **It's agent-agnostic.** `playwright-cli` is a CLI; the skill is a
  markdown playbook. Use it from Claude Code, Copilot CLI, Cursor,
  Continue — anywhere you can install a skill.

If you want to try it:

- **The CLI:** [`@playwright/cli`](https://www.npmjs.com/package/@playwright/cli) (`npm install -g @playwright/cli@latest`)
- **The skill:** ships with the CLI; install it into your agent's skill directory.
- **The full reference:** the [spec-driven-testing playbook](https://github.com/microsoft/playwright/blob/main/packages/playwright-cli/skill/references/spec-driven-testing.md)
  inside the skill spells out the plan → generate → heal loop in
  detail, including what to do when you can't tell whether the spec or
  the app is right.

Write the spec. Let the agent write the test. When the world changes,
let it decide which one to update — and tell you why.
