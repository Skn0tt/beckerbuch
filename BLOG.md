# Spec-driven Playwright testing with `playwright-cli`

// this feels very length and contrived and from the past. can we cut it short? maybe we can also link out to our previous blog post, people might wonder why we're publishing the same thing twice.
Most Playwright suites are written like this: build the feature, open
DevTools, fish out a selector, write a test, repeat. A month later the
selector breaks, a teammate "fixes" it by swapping `getByText` for
`locator(".btn-primary > span")`, and nobody remembers what the test
was actually trying to prove. The suite slowly turns into a wall of
green CI that nobody trusts.

**Spec-driven testing** flips that around. You write a short,
human-readable spec first — what scenarios matter, what the user should
see — and an agent generates the Playwright code from it. The spec
stays the source of truth. When the test fails, you don't go hunting
for selectors; you ask "did the user-visible behaviour change, or did
it not?" The spec gives you something concrete to reconcile against.

In this post I'll walk through the **plan → generate → heal** loop using
[`playwright-cli`](https://www.npmjs.com/package/@playwright/cli) and the
matching agent skill. The running example is a tiny cookbook app with
a recipe-import feature — paste a URL, get a prefilled recipe form.

---

## Setup

// this is too long. let's cut it short and link out to some other authoritative doc on what the CLI is.

You need two things.

**1. The CLI itself.** `playwright-cli` is a thin command surface over
a real Playwright browser, designed to be driven by an agent (or by
you, on the terminal):

```bash
npm install -g @playwright/cli@latest
playwright-cli open https://example.com
playwright-cli snapshot
```

Each command prints both the browser action *and* the equivalent
Playwright TypeScript — so anything the agent does in the browser, you
can paste straight into a test.

**2. The `playwright-cli` skill.** This is the playbook your agent
reads to know *how* to use the CLI — when to snapshot, how to attach
to a paused test, what a spec file looks like, what "heal" means. It
works with Claude Code, Copilot CLI, Cursor, or any other coding agent
that supports skills. Drop it into your repo (or install it
user-wide), and your agent now knows the workflow without you
explaining it every time.

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

// lets immediately just mention the BBC good food URL here! the one test case we want it to generate is about parsing this one URL
> Use the `playwright-cli` skill to explore the recipe-import feature
> and produce a spec file under `specs/recipe-import.plan.md`. Cover
> the happy path, validation, and at least one regression-prone case
> (e.g. ingredient parsing with awkward units).

The agent launches a debug session, attaches with `playwright-cli`,
clicks through the importer the way a user would, and writes a spec
file like this:

```markdown
# Recipe Import Test Plan

## Application Overview
The importer accepts a recipe URL, fetches the page, parses its
schema.org Recipe metadata, and prefills the new-recipe form. The user
can edit the result before saving.

## Test Scenarios

### 1. Generic web import

**Seed:** `tests/fixtures.ts` (logged-in user, empty recipe list)

#### 1.1 paste-url-prefills-form
**File:** `tests/recipe-import/paste-url-prefills-form.spec.ts`
**Steps:**
  1. Click "New recipe", then "Import from URL".
    - expect: an input labelled "Recipe URL" is visible
  2. Paste a known recipe URL and click "Import".
    - expect: the form name field is filled with the recipe title
    - expect: the ingredient list has at least one row
    - expect: the steps textarea is non-empty

#### 1.2 bbc-good-food-exact-ingredients
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

> Generate Playwright tests for scenario 1.2 of
> `specs/recipe-import.plan.md` using the `playwright-cli` skill.

The agent reattaches to a debug session, walks the spec's steps in the
real browser, and produces a `*.spec.ts` file:

```ts
// spec: specs/recipe-import.plan.md scenario 1.2
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

## Step 3 — A few days later, the upstream page changes

// let's have this smaller. we can just say that bbcgoodfood.com changed and our test is failing; and that we explicitly did not mock out this third party server because that's what the feature is all about.
Here's the question that always comes up with this kind of test:
*"isn't hitting `bbcgoodfood.com` from CI brittle? Shouldn't you mock
it?"*

For most network-touching tests, yes — mock. But for an *importer*
specifically, the brittleness is the whole point. The reason the
feature exists is to parse third-party pages we don't control. If BBC
Good Food renames a field in their JSON-LD, or Chefkoch wraps their
ingredients in a new element, we *want* to know. A mocked test
guarantees we'll keep passing right up until the moment our users hit
"Import" on a real URL and get garbage.

So we point a small number of high-signal tests at the real upstream.
They're an early-warning system for upstream format drift.

…and one morning, CI goes red:

```diff
  - row:
    - cell "200"
    - cell "g"
-   - cell "young goat's cheese"
+   - cell "mature goat's cheese"
```

// no, it's not really the signal we wanted. it's noise. them tweaking the contents is not what we wanted to detect, we want to detect them tweaking the format. so this is noise, but the nice thing is that the agent can fix the noise on its own super easy.
That's exactly the signal we wanted: BBC tweaked an ingredient name on
the page. Now we need to decide: is the parser wrong, or is this
"reality changed, our spec is stale"?

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
