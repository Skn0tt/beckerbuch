# Spec-driven Playwright testing with `playwright-cli`

We've [written before](https://dev.to/playwright/playwright-agents-planner-generator-and-healer-in-action-5ajh)
about spec-driven testing and the plan → generate → heal loop via Playwright Test Agents.
This post shows how to use spec-driven testing with `playwright-cli`.

---

## Setup

You need two things:

// I fixed the link. please look at how skill installation works and put the explicit commands here so folks can copy without having to browse around.
- **The CLI** — `npm install -g @playwright/cli@latest`. See the
  [`playwright-cli` docs](https://playwright.dev/agent-cli/introduction)
  for the full surface; for our purposes, every command it runs also
  prints the equivalent Playwright TypeScript.
- **The skill** — the agent playbook that teaches Claude Code, Copilot
  CLI, Cursor (or anything else that supports skills) *how* to use the
  CLI for plan / generate / heal. Drop it into your repo and you're
  done.

---

## Step 1 — Generate the spec

Imagine we just shipped a recipe import feature in our cookbook app.
The user can paste a recipe URL from somewhere on the web — BBC Good Food, Chefkoch, an old food
blog — and the app fetches the page, parses its
[schema.org Recipe](https://schema.org/Recipe) JSON-LD, and prefills the
new recipe form.

To generate a spec for this, we open our agent and ask it to:

> Use the `playwright-cli` skill to explore the new recipe-import feature
> and produce a spec.
> Include a scenario that imports
> `https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese`
> and asserts the parsed ingredients exactly.

The agent launches a debug session, attaches with `playwright-cli`,
clicks through the importer the way a user would, and writes a spec
file like this:

// I'm not sure it would actually look like this. can you try it out and replace this with the real spec? feel free to delete the existing spec and test if needed.
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

---

## Step 2 — Generate the test

Now the second prompt:

> Generate Playwright tests for scenario 1.1 of the spec.

The agent reattaches to a debug session, walks the spec's steps in the
real browser, and produces a `*.spec.ts` file:

// same here, try out the prompt and see what it really looks like
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

The `// spec:` header at the top of the file is the link back to the
plan. When this test fails later, you (or your agent) know exactly
which scenario to reconcile against.

---

## Step 3 — A few days later, CI goes red

// this is roundabout, just say that the CI going red means that maybe something changed in the format of bbcgoodfood and it might mean our parser needs updates.
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

// check if it really does this. in this case, I think it can immediately fix it just by looking at the error message. the key thing is that the agent also updates the spec along with the test, please verify that manually.
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
