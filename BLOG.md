# Spec-driven Playwright testing with `playwright-cli`

We've [written before](https://dev.to/playwright/playwright-agents-planner-generator-and-healer-in-action-5ajh)
about spec-driven testing and the plan → generate → heal loop via Playwright Test Agents.
This post shows how to use spec-driven testing with `playwright-cli`.

---

## Setup

Two commands to set up everything you need:

```bash
# 1. The CLI itself.
npm install -g @playwright/cli@latest

# 2. The agent skill — choose your flavour:
playwright-cli install --skills=claude   # for Claude Code / Skills-aware agents
playwright-cli install --skills=agents   # for Cursor, Copilot CLI, Continue, …
```

The CLI is documented at
[playwright.dev/agent-cli](https://playwright.dev/agent-cli/introduction);
the skill is a markdown playbook that teaches the agent *how* to use
the CLI for plan / generate / heal so you don't have to spell it out
every time.

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

```markdown
# Recipe Import Test Plan

## Application Overview

The generic import modal fetches real schema.org recipe pages, prefills
the recipe form with parsed data, imports a cover image, and saves the
result as a normal recipe.

## Test Scenarios

### 1. Live URL Import Modal

**Seed:** `tests/fixtures.ts` (flat fixture: provisions a fresh tenant
+ first user, leaves browser logged out)

#### 1.1. import-bbc-good-food-baked-ratatouille-prefills-exact-ingredients

**File:** `tests/recipe-import-ui-live.spec.ts`

Asserts the import modal extracts every ingredient from the source
URL into the recipe form with the exact amount, unit, and item — not
just sanity counts. Catches regressions where unit detection drops
`tbsp`/`tsp`/`ml`/`g`, where unitless counts (e.g. "2 red onions") get
a spurious unit, or where the "For the cheese sauce" subsection is
skipped.

**Steps:**
  1. Log in, open `/recipes/new`, and click `Import recipe`.
    - expect: The `Import a recipe` heading is visible.
  2. Paste `https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese` and click `Import`.
    - expect: The Name field contains `ratatouille`.
    - expect: The ingredient rows in the form contain exactly the following 15 entries, in source order. Prep notes (e.g. "chopped", "finely grated") stay attached to the item rather than being silently dropped:
      1. `{ amount: "4", unit: "tbsp", item: "olive oil" }`
      2. `{ amount: "2", unit: "", item: "red onions chopped" }`
      3. `{ amount: "2", unit: "", item: "garlic cloves finely chopped" }`
      …
      10. `{ amount: "200", unit: "g", item: "young goat's cheese" }`
      …
  3. Click `Save recipe`.
    - expect: The browser lands on a recipe detail URL.
```

---

## Step 2 — Generate the test

Now the second prompt:

> Generate a Playwright test for scenario 1.1 of the spec.

The agent reattaches to a debug session, walks the spec's steps in the
real browser, and produces a `*.spec.ts` file:

```ts
test("import BBC Good Food baked ratatouille prefills exact ingredients", async ({
  page,
  flat,
}) => {
  await login(page, flat.user);
  await page.goto("/recipes/new");

  // 1. Open the import modal.
  await page.getByRole("button", { name: /import recipe/i }).click();
  await expect(
    page.getByRole("heading", { name: /import a recipe/i }),
  ).toBeVisible();

  // 2. Paste the BBC Good Food URL and import.
  await page
    .getByLabel("Recipe URL or kptncook link / id")
    .fill("https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese");
  await page.getByRole("button", { name: "Import", exact: true }).click();

  await expect(page.getByLabel("Name")).toHaveValue(/ratatouille/i);

  // Assert the whole ingredients table as one ARIA snapshot so a single
  // soft failure shows every mismatched row, amount, unit, and item at once.
  await expect.soft(page.getByRole("table", { name: "Ingredients" }))
    .toMatchAriaSnapshot(`
      - table "Ingredients":
        - rowgroup:
          - row "Amount Unit Item Actions":
            - columnheader "Amount"
            - columnheader "Unit"
            - columnheader "Item"
            - columnheader "Actions"
        - rowgroup:
          - row:
            - cell "4"
            - cell "tbsp"
            - cell "olive oil"
          - row:
            - cell "2"
            - cell
            - cell "red onions chopped"
          # … 13 more rows …
          - row:
            - cell "200"
            - cell "g"
            - cell "young goat's cheese"
          # …
    `);

  // 3. Save.
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
});
```

---

## Step 3 — Heal

A few days later, CI goes red:

```diff
  - row:
    - cell "200"
    - cell "g"
-   - cell "young goat's cheese"
+   - cell "mature goat's cheese"
```

Something on the BBC page changed. Could be the format their parser
relies on, in which case our parser may need updates; could just be a
content edit. Either way, we need to triage.

(Note: we deliberately didn't mock `bbcgoodfood.com`. The whole point
of this test is to catch the day a third party changes what we depend
on — a mocked test would happily go green right up until our users
hit "Import" on a real URL and got garbage.)

We hand the failure to the agent:

> This test is failing. Use the `playwright-cli` skill to debug it,
> decide whether the spec or the parser is the source of truth, and
> update whichever is wrong.

In this case the agent doesn't have to reattach the browser at all —
it greps the failure output for the one row that doesn't match, checks
that the live page really does serve `young goat's cheese`, and
concludes our spec drifted. It then updates **both files** in one
shot: the aria snapshot in the test and the matching line in the
spec. (That dual update isn't optional — the skill's heal step
explicitly says user-visible changes have to be reconciled in the
spec, not just the test.)

If instead the page was unchanged but our parser had regressed (say,
we dropped the "g" unit somewhere), the agent would go the other way
— keep the spec, fix the parser. The point is that "did we change
intent, or did we break something" is no longer a guess; it's an
explicit decision recorded in the diff.

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
