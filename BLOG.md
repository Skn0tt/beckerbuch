# Spec-driven testing with `playwright-cli`

We've [written before](https://dev.to/playwright/playwright-agents-planner-generator-and-healer-in-action-5ajh) about spec-driven testing and the plan → generate → heal loop via Playwright Test Agents.
This post shows the same loop with `playwright-cli`.

> If you haven't installed `playwright-cli` yet, here's how:
> 
> ```bash
> npm install -g @playwright/cli@latest
> playwright-cli install --skills
> ```
> You can find out more at [https://playwright.dev/agent-cli/introduction](https://playwright.dev/agent-cli/introduction).

## Step 1: Plan

Say we just shipped a recipe import feature in our cookbook app. The user pastes a recipe URL and the app fetches the page, parses its [schema.org Recipe](https://schema.org/Recipe) JSON-LD, and prefills the new-recipe form.

To generate a spec, we open the coding agent and ask:

> Use the `playwright-cli` skill to explore the new recipe-import feature and produce a spec. Include a scenario that imports `https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese` and asserts the parsed ingredients exactly.

The agent reads the spec-driven-testing section of the playwright-cli Skill, then it attaches to a test debug session, clicks through the importer, and writes a spec:

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

Since this spec is plain english markdown, it can be reviewed without knowing TypeScript!
If you're unhappy with some details, you can give feedback to the agent or just edit the spec.md file directly.

## Step 2: Generate

To turn the spec into a Playwright Test, ask your agent:

> Generate a Playwright test for scenario 1.1 of the spec.

The agent starts another test debug session, walks through the steps in the real browser, and writes:

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

  await expect(page.getByRole("table", { name: "Ingredients" }))
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

Running the test shows it's green.

---

## Step 3: Heal

A few days pass. CI goes red; something on the recipe page changed. If they changed their format, it might mean we have to fix our importing logic. In this case, it was just a content edit:

```diff
  - row:
    - cell "200"
    - cell "g"
-   - cell "young goat's cheese"
+   - cell "mature goat's cheese"
```

We hand the failure to the agent:

> This test is failing, decide what to do about it.

The agent doesn't need to reattach the browser — it greps the failure for the row that doesn't match, checks that the live page really does serve `mature goat's cheese`, concludes our spec drifted, and updates **both files** in one shot: the aria snapshot in the test *and* the matching line in the spec.
The skill's heal step is explicit about this — user-visible changes get reconciled in the spec, not just patched in the test.

If the content were unchanged but the format regressed our parser (say, we dropped the "g" unit somewhere), the agent would go the other way: keep the spec, fix the parser.

In short, spec-driven testing allows keeping tests as prose which can be useful. Agents make it easy to keep the test implementation in sync with the spec. Give it a try!
