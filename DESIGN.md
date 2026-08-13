# cookbook — Design

> Recipe collection + shopping-list planner for a flat-share, optimised for the
> draft → finalise → in-stock → cook loop, with one-click handoff to **Bring!**.
>
> **Status:** Product spec, v1. Technical design lives elsewhere.

---

## 1. The story we're telling

Our flat keeps a growing list of recipes we like. Once a week we sit down,
pick a handful for the coming days, scale them up or down, and turn that into
a single combined shopping list. We send that list into Bring! and go shop.
When we come home, the recipes we just shopped for are "in stock" — anyone in
the flat can grab one, cook it, and tick it off.

cookbook is the quiet helper for that loop. It is **not** a meal planner with
calendars, not a nutrition tracker, not a recipe discovery feed. It is the
shared notebook + clipboard + fridge-whiteboard that our flat already has,
just digital, shared, and good at exporting to Bring!.

## 2. Who it's for

A single flat (household) of a few people who:

- already collaborate on shopping and cooking,
- have a shared bank of recipes they cycle through,
- use **Bring!** for the actual shop.

Everything in v1 sits behind login. There is no public surface.

## 3. Core concepts

| Concept            | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| **Flat**           | A household. Owns a recipe collection, a draft, an in-stock list, history. |
| **User**           | A person. Belongs to exactly one flat in v1.                               |
| **Recipe**         | A reusable definition: name, ingredients at a base quantity, steps.        |
| **Draft**          | The single in-progress shopping list for the flat.                         |
| **Shopping list**  | The set of recipes that just went into Bring! when a draft was finalised.  |
| **In stock**       | Recipes the flat currently has the ingredients for. The "ready to cook" board. |
| **Cooked history** | A log of what got cooked, when, and by whom.                               |

## 4. The flow

```
   ┌──────────┐  add recipe ×N    ┌────────┐  finalise   ┌───────────────┐
   │ Recipes  │ ────────────────▶ │ Draft  │ ──────────▶ │ Shopping list │
   └──────────┘                   └────────┘             └──────┬────────┘
        ▲                                                       │ export
        │ edit / add new                                        ▼
        │                                                  ┌─────────┐
        │                       cook & tick off            │ Bring!  │
        │                  ┌──────────────────────┐        └─────────┘
        │                  ▼                      │             │
        │           ┌──────────────┐    ┌─────────┴──────┐      │
        └───────────│ Cooked hist. │ ◀──│   In stock     │ ◀────┘
                    └──────────────┘    └────────────────┘   recipes flow in
```

### 4.1 Recipes

Each recipe holds:

- **Name**
- **Base quantity** (e.g. "serves 2", "yields 4 portions") — the unit the
  ingredient amounts are noted in.
- **Ingredients** — a list of `{ amount, unit, item }` lines tied to the base
  quantity.
- **Steps** — free-form instructions.
- **Source URL** — where we got it (blog, video, etc.).
- **Photo** — one image, optional.

Recipes are owned by the flat. Anyone in the flat can create, edit, and
delete them. There is no per-recipe ownership in v1.

**Importing recipes.** The "Add recipe" form accepts a URL (or recipe
id) as an alternative to typing all the fields in. Two sources are
supported: a **kptncook** share URL / recipe id (resolved via the
kptncook mobile API), and **any recipe page** that publishes schema.org
`Recipe` metadata as JSON-LD (the format used by the vast majority of
recipe sites and food blogs). In both cases the server fetches and
normalizes the recipe, pre-fills the form (name, ingredients, steps,
photo), and the user reviews/edits before saving. A `fetch_recipe` MCP
tool exposes the same import path (both sources) for agents. Fetching
arbitrary user-supplied URLs is guarded against SSRF (http(s) only;
private/loopback/link-local addresses are refused).

> **Out of scope for v1:** tags/categories, cuisine, difficulty, prep time,
> per-user notes, versioning of edits. Importers also drop fields that
> have no home in our schema (prep/cook time, nutrition, categories).

#### Searching the collection

The collection grows.
Finding a recipe again has to feel instant, not like
scrolling.
There is good Search support.

### 4.2 Drafting a shopping list

The flat has **one rolling draft** at any time. There is no "new draft"
button — the draft is just always there, and finalising it empties it for the
next round.

To plan the week, anyone in the flat:

1. Opens the draft.
2. Adds recipes from the collection. Each added recipe gets a **target
   quantity** in the recipe's own unit (e.g. servings, portions). It
   defaults to the recipe's base quantity, and can be nudged up or down
   freely — `4 → 5`, `4 → 6`, `4 → 3` — not just in whole multiples of the
   base. Ingredient amounts scale linearly with `target / base`. No
   per-line omits, no swaps; if a recipe needs to be different, edit the
   recipe itself.
3. Optionally assigns a **designated cook** (one of the flat's users) to a
   recipe in the draft.
4. Removes recipes that no longer fit.

The draft shows two views side by side (or stacked on mobile):

- **Recipes in this draft** — the human-meaningful list.
- **Combined shopping list** — ingredients across all recipes, summed and
  deduplicated by `(item, unit)`. This is the preview of what will land in
  Bring!.

> **Out of scope for v1:** ad-hoc non-recipe items in the list (e.g. toilet
> paper). The list is purely the union of recipe ingredients. If we want
> household items, we add them straight in Bring!.

### 4.3 Finalising

When we're ready to shop, one person hits **Finalise**.

Finalising:

1. Snapshots the combined shopping list.
2. Exports it to Bring! (see §4.4).
3. Moves every recipe in the draft into **In stock** (carrying its target
   quantity and assigned cook, if any).
4. Empties the draft so the next planning cycle can start clean.

### 4.4 Bring! handoff

We export the combined shopping list as a public page (`/h/:flatId`)
that exposes [recipe schema.org JSON-LD](https://schema.org/Recipe).
Bring!'s official import widget on that page opens the app with the
page URL; Bring's parser scrapes `recipeIngredient`. The same JSON-LD
also works if someone shares the URL into Bring! some other way.

> The Bring! integration is a one-way push; cookbook never reads back from
> Bring!. If something gets bought outside the list, that's invisible to us
> and that's fine.

The handoff page also shows a **combined shopping list** on top that
merges near-duplicate ingredients across recipes (e.g. `"300 g tomato"`
+ `"300 g tomatos"` → `"600 g tomato"`). An LLM proposes the
groupings at Finalise time; the server owns the unit arithmetic and
display. Each merged group has a **Split** button so a human can
reject a wrong merge (rejected groups expand back into their source
lines in both the UI and the JSON-LD). If recipes are edited after
Finalise, the snapshot becomes stale and the page renders an
all-singletons fallback with a **Regenerate** button. See TECH.md
§6.3.

### 4.5 In stock

The in-stock board lists every recipe currently shoppable-for-cooking. For
each entry:

- The recipe (with link to full view).
- The target quantity it was finalised at.
- The designated cook, if any. Anyone can assign, change, or clear this at
  any time — both during drafting and once it's in stock.
- A **Cooked** action.

Hitting **Cooked** removes the recipe from in-stock and writes a row to
cooked history (`recipe`, `cooked_at`, `cooked_by`, `quantity`). Cooking
is binary — there is no "cooked half of it" state. If we shopped for a
larger quantity and only cooked part of it, that's a recipe still fully in
stock in spirit; v1 doesn't try to model that precisely.

An in-stock recipe can also be **demoted back to draft** from its detail
page (a **← Back to draft** action, behind a confirmation). This is the
per-recipe inverse of finalise: it clears the instance's `finalised_at`,
appends it to the end of the draft, and keeps its portions, designated
cook, note and omitted ingredients so it's immediately editable again.
Finalise itself is still bulk and one-way for the draft as a whole — this
just lets you pull a single recipe back out of stock when it was shopped
for by mistake or plans changed.

### 4.6 Cooked history

A simple chronological log: what got cooked, when, by whom, at what
target quantity. Used for:

- "What have we been eating lately?"
- Eventually: surfacing repeat-favourites when drafting.

No edits, no ratings, no comments in v1. **No UI surface in v1 either** —
the data is recorded so we can query it manually (and so future features
like repeat-favourites have history to draw on), but there's no in-app
view of it yet. Agents can pull a flat-scoped dump via the MCP tool
`kochbuch_export_analysis` (normalized JSON tables: recipes, ingredients,
cooked — with cook/recipe names on each cooked row) and analyze locally.
Live Draft / In stock state is separate: `kochbuch_get_plan` /
`kochbuch_update_plan` (finalise / Bring! handoff remains UI-only).

## 5. Users & access

- **Auth-gated.** The whole app requires login. No anonymous access.
- **One flat per user** in v1.
- **Flat membership.** A flat has 1+ members. Any member can do anything
  inside the flat: edit recipes, edit the draft, finalise, mark cooked,
  reassign cooks. There are no roles.
- **Inviting** a new member into a flat is a flow we need but is intentionally
  light: an existing member generates an invite link/code, the new user signs
  up and joins.

> **Out of scope for v1:** roles/permissions, leaving/removing members,
> transferring a flat, multi-flat users.

## 6. Designated cook

A recipe in the draft or in-stock list can optionally have one user assigned
as its designated cook. This is a soft signal ("I'll take this one"), not an
enforcement — anyone can still mark it cooked, anyone can reassign. Empty is
a valid state and is the default.

## 7. Non-goals (v1)

To keep the scope honest, these are explicitly **not** in v1:

- Calendar / day-by-day meal planning.
- Nutrition info.
- Pantry tracking beyond the in-stock board (no "we have 200g flour left").
- Ad-hoc / household items in the shopping list.
- Per-line ingredient editing in the draft (only the recipe-wide target
  quantity is adjustable).
- Multiple concurrent drafts.
- Roles, permissions, multi-flat users.
- Ratings, comments, social features.
- Importing recipe metadata beyond schema.org JSON-LD (microdata,
  hRecipe, RDFa) — effectively extinct on the modern web.
- Reading state back from Bring!.

## 8. Future: public collections (v2 placeholder)

We may eventually want to make a flat's recipe collection (or a curated
subset) **publicly viewable** — a shareable link that shows recipes
read-only, without exposing drafts, in-stock, history, or membership. This
is not in v1 and the data model should not be designed around it, but we
flag it here so v1 decisions don't accidentally close the door:

- Recipes should be cleanly separable from flat-internal state.
- Nothing flat-private (members, draft, history) should be entangled into
  recipe records.

Open questions for v2: per-recipe visibility vs. whole-collection,
attribution, forking into another flat's collection.

## 9. Glossary

- **Bring!** — third-party shopping-list app (getbring.com) used by the
  household for the actual in-store shop.
- **Base quantity** — the serving size a recipe's ingredients are written
  for (e.g. "serves 4"). The default starting point when the recipe is
  added to the draft.
- **Target quantity** — the serving size a recipe is being cooked at *this*
  time. Defaults to the base quantity, freely adjustable in the recipe's
  own unit (4 → 5, 4 → 3, etc.). Ingredient amounts in the shopping list
  scale linearly with `target / base`.
- **Finalise** — the one-way action that turns the draft into a shopping
  list and pushes recipes into in-stock.
