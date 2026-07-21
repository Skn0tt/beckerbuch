# cookbook — UI mockups

> ASCII wireframes for every v1 screen. Resting layouts only — interactions
> are noted as bullets, not drawn. See [`DESIGN.md`](./DESIGN.md) for the
> product story and vocabulary.
>
> **Conventions**
> - Desktop boxes ~90 cols, mobile boxes ~36 cols.
> - `🔍`, `👤`, `↗`, `✓` etc. used as iconography placeholders.
> - `[Button]` = button. `[ field _________ ]` = input.

---

## Layout philosophy

**Desktop = two panes.** A main pane that hosts either the collection
list **or** a single recipe (master-detail in one pane), and a right
sidebar with Draft + In stock (collapsible). Everything else — recipe
edit, finalise, Bring! handoff, history, settings — opens as a modal.

**Mobile = two bottom tabs.** `Recipes · Kitchen`. The Kitchen tab uses
a segmented control to switch between Draft, In stock, and Ingredients
(planned shopping summary over everything currently in stock), mirroring
the desktop sidebar. Lower-frequency surfaces (history, settings, sign out)
live behind the **⚙** icon in the top bar — same on both form factors.

```
DESKTOP                                       MOBILE
┌─────────────────────────────────────────┐   ┌──────────────────┐
│ top bar                              ⚙  │   │ top bar       ⚙  │
├──────────────────────────────┬──────────┤   │                  │
│                              │ Draft    │   │ tab content      │
│ collection list              │ ──────── │   │                  │
│   — or —                     │ In stock │   │                  │
│ selected recipe              │          │   │                  │
│                              │          │   │                  │
└──────────────────────────────┴──────────┘   ├──────────────────┤
                                              │  Recipes │ Kitchen│
                                              └──────────────────┘
```

The **⚙** menu (both form factors):

```
┌──────────────────────┐
│ Flat settings        │
│ ────────────────     │
│ Sign out             │
└──────────────────────┘
```

> Cooked history is recorded in the database (DESIGN.md §4.6) but has no
> UI in v1 — we'll query it manually when we want to look back.

---

## 1. Login

**Purpose:** gate the app. Auth method TBD; treat as placeholder.

```
DESKTOP                                          MOBILE
┌──────────────────────────────────────────┐    ┌──────────────────────────────────┐
│                                          │    │                                  │
│           ┌────────────────────┐         │    │            cookbook              │
│           │     cookbook       │         │    │                                  │
│           │                    │         │    │   Email                          │
│           │ Email              │         │    │   [ ____________________ ]       │
│           │ [ ________________]│         │    │                                  │
│           │ Password           │         │    │   Password                       │
│           │ [ ________________]│         │    │   [ ____________________ ]       │
│           │                    │         │    │                                  │
│           │ [    Sign in     ] │         │    │   [        Sign in           ]   │
│           │                    │         │    │                                  │
│           │ Have an invite? ↗  │         │    │   Have an invite? ↗              │
│           └────────────────────┘         │    │                                  │
│                                          │    │                                  │
└──────────────────────────────────────────┘    └──────────────────────────────────┘
```

- Sign-in errors render inline above the button.
- "Have an invite?" → invite-redemption flow (out of scope for this doc; lands you in the right flat).

---

## 2. Workspace (desktop home) — collection view

**Purpose:** the home screen. Browse and search the collection in the
main pane; glance at Draft + In stock in the sidebar.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ cookbook                                              Anna · Flat: Wohnung 3        ⚙  │
├──────────────────────────────────────────────────────┬──────────────────────────────────┤
│ COLLECTION                                           │ DRAFT                    (4) [+]│
│ 🔍 [ chick________________________________ ]         │ ──────────────────────────────── │
│                                                      │ Pasta al limone                  │
│ Chicken katsu                              14d ago   │   serves [ 4 ⏶⏷]   👤 Tom       │
│   chicken thigh, panko, …                            │ Chicken katsu                    │
│                                                      │   serves [ 6 ⏶⏷]   👤 –         │
│ Chicken miso soup                           3d ago   │ Linsensuppe                      │
│   chicken, miso, scallion, …                         │   serves [ 8 ⏶⏷]   👤 Anna      │
│                                                      │ Pasta al limone                  │
│ Hähnchencurry                              1mo ago   │   serves [ 4 ⏶⏷]   👤 –         │
│   chicken, curry paste, …                            │                                  │
│                                                      │ ▼ Combined list preview          │
│ — full collection —                                  │   400 g spaghetti                │
│                                                      │   500 g chicken thigh            │
│ Pasta al limone                             2d ago   │   2 lemons                       │
│ Linsensuppe                                 5d ago   │   …                              │
│ Ofengemüse                                  6d ago   │                                  │
│ …                                                    │ [        Finalise →            ] │
│                                                      │ ──────────────────────────────── │
│                                                      │ IN STOCK                  (2)    │
│                                                      │ ──────────────────────────────── │
│                                                      │ Hähnchencurry                    │
│                                                      │   serves 4   👤 Anna             │
│                                                      │   [ ✓ Cooked ]                   │
│                                                      │ Ofengemüse                       │
│                                                      │   serves 6   👤 –                │
│                                                      │   [ ✓ Cooked ]                   │
│                                                      │ ──────────────────────────────── │
│ [+ New recipe]                                       │ [ « Collapse sidebar ]           │
└──────────────────────────────────────────────────────┴──────────────────────────────────┘
```

- Search box focused on load; results highlight matches; default sort = most-recently-used (last cooked → last edited). See DESIGN.md §4.1.
- Clicking a recipe row swaps the main pane to **Recipe detail** (§3).
- Sidebar Draft: per-recipe target-quantity stepper, designated-cook chip (click to assign/clear), reorder via drag.
- "Combined list preview" expands/collapses a deduplicated `(item, unit)` view of the merged ingredients. See DESIGN.md §4.2.
- "Finalise →" opens **Finalise confirmation** (§7).
- Sidebar In stock: per-recipe **Cooked** action removes it and writes a history entry (DESIGN.md §4.5/4.6).
- "« Collapse sidebar" collapses to the thin rail (§10).
- ⚙ opens the menu shown in *Layout philosophy*: Flat settings (§9), Sign out.

---

## 3. Workspace — recipe view

**Purpose:** read a recipe; act on it (edit, add to draft). Same window
as §2; the main pane swaps to a single-recipe detail with a back arrow
to the collection. Sidebar stays put.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ cookbook                                              Anna · Flat: Wohnung 3        ⚙  │
├──────────────────────────────────────────────────────┬──────────────────────────────────┤
│ ← Collection                                         │ DRAFT                    (4) [+]│
│                                                      │ ──────────────────────────────── │
│ Pasta al limone                              [Edit]  │ Pasta al limone                  │
│                                                      │   serves [ 4 ⏶⏷]   👤 Tom       │
│ ┌────────────────────────────────────┐               │ Chicken katsu                    │
│ │            [photo]                 │               │   serves [ 6 ⏶⏷]   👤 –         │
│ └────────────────────────────────────┘               │ …                                │
│                                                      │                                  │
│ Base: serves 4                                       │ [        Finalise →            ] │
│                                                      │ ──────────────────────────────── │
│ [   + Add to draft   ]                               │ IN STOCK                  (2)    │
│                                                      │ ──────────────────────────────── │
│ Ingredients (serves 4)                               │ Hähnchencurry                    │
│ • 400 g spaghetti                                    │   serves 4   👤 Anna             │
│ • 2 lemons                                           │   [ ✓ Cooked ]                   │
│ • 100 g parmesan                                     │ Ofengemüse                       │
│ • 1 bunch parsley                                    │   serves 6   👤 –                │
│ • olive oil, salt, pepper                            │   [ ✓ Cooked ]                   │
│                                                      │ ──────────────────────────────── │
│ Steps                                                │ [ « Collapse sidebar ]           │
│ 1. Boil salted water…                                │                                  │
│ 2. …                                                 │                                  │
│                                                      │                                  │
│ Source: smittenkitchen.com ↗                         │                                  │
└──────────────────────────────────────────────────────┴──────────────────────────────────┘
```

- "← Collection" returns the main pane to §2 with the previous scroll
  position and search query intact.
- "Edit" opens **Recipe edit** (§4) as a modal.
- "+ Add to draft" appends the recipe to the sidebar Draft at base
  quantity. The button flips to "✓ in draft" while it's there. The
  same recipe can be added more than once (each becomes a separate
  draft entry).
- When the recipe is **in stock**, the detail view shows **Mark as cooked**
  alongside a **← Back to draft** action (behind a confirmation) that
  demotes the single in-stock instance back into the draft, keeping its
  portions, cook, note and omitted ingredients. See DESIGN.md §4.5.
- A `…` overflow on the header hosts less-frequent actions (e.g.
  Delete recipe).

---

## 4. Recipe edit / create

**Purpose:** author or edit a recipe.

```
DESKTOP (modal over workspace)                        MOBILE (full-screen)
┌────────────────────────────────────────────────┐   ┌──────────────────────────────────┐
│ Edit recipe                                ✕   │   │ ✕   New recipe          [Save]   │
├────────────────────────────────────────────────┤   ├──────────────────────────────────┤
│ Name                                           │   │ Name                             │
│ [ Pasta al limone ____________________ ]       │   │ [ ____________________ ]         │
│                                                │   │                                  │
│ Photo                  Source URL              │   │ Photo  [ + Upload ]              │
│ [ + Upload ]           [ https://… ]           │   │                                  │
│                                                │   │ Source URL                       │
│ Base quantity                                  │   │ [ https://… ]                    │
│ [ 4 ] [ servings ▾ ]                           │   │                                  │
│                                                │   │ Base quantity                    │
│ Ingredients                                    │   │ [ 4 ] [ servings ▾ ]             │
│ ┌─ amt ──┬─ unit ──┬─ item ─────────────────┐  │   │                                  │
│ │  400   │   g     │ spaghetti              │ ✕│   │ Ingredients                      │
│ │   2    │  pcs    │ lemons                 │ ✕│   │ ┌──────────────────────────────┐ │
│ │  100   │   g     │ parmesan               │ ✕│   │ │ 400 g  spaghetti          ✕  │ │
│ │   1    │ bunch   │ parsley                │ ✕│   │ │ 2 pcs  lemons             ✕  │ │
│ └────────┴─────────┴────────────────────────┘  │   │ │ 100 g  parmesan           ✕  │ │
│ [ + Add ingredient ]                           │   │ │ 1 bunch parsley           ✕  │ │
│                                                │   │ └──────────────────────────────┘ │
│ Steps                                          │   │ [ + Add ingredient ]             │
│ ┌────────────────────────────────────────────┐ │   │                                  │
│ │ 1. Boil salted water…                      │ │   │ Steps                            │
│ │ 2. …                                       │ │   │ ┌──────────────────────────────┐ │
│ │                                            │ │   │ │ 1. Boil salted water…        │ │
│ └────────────────────────────────────────────┘ │   │ │ 2. …                         │ │
│                                                │   │ └──────────────────────────────┘ │
│           [ Cancel ]   [    Save    ]          │   │                                  │
└────────────────────────────────────────────────┘   └──────────────────────────────────┘
```

- New recipe and edit use the same form. Title flips between "Edit recipe" / "New recipe".
- Steps is a single multiline textarea (numbered by convention, not enforced) — keeps authoring quick.
- Ingredient rows reorder by drag (desktop) / long-press (mobile).

---

## 5. Mobile — Recipes tab

**Purpose:** the mobile equivalent of the workspace's collection pane.
Uses standard push navigation: list → recipe detail.

```
MOBILE — list                                         MOBILE — detail
┌──────────────────────────────────┐                 ┌──────────────────────────────────┐
│ Recipes                       ⚙  │                 │ ←  Pasta al limone        [Edit] │
├──────────────────────────────────┤                 ├──────────────────────────────────┤
│ 🔍 [ chick_______________ ]      │                 │ ┌──────────────────────────────┐ │
│                                  │                 │ │           [photo]            │ │
│ ┌──────────────────────────────┐ │                 │ └──────────────────────────────┘ │
│ │ Chicken katsu                │ │                 │                                  │
│ │ • chicken thigh, panko, …    │ │                 │ Base: serves 4                   │
│ │ last cooked 14d ago          │ │                 │                                  │
│ └──────────────────────────────┘ │                 │ [   + Add to draft           ]   │
│ ┌──────────────────────────────┐ │                 │                                  │
│ │ Chicken miso soup            │ │                 │ Ingredients (serves 4)           │
│ │ • chicken, miso, scallion, … │ │                 │ • 400 g spaghetti                │
│ │ last cooked 3d ago           │ │                 │ • 2 lemons                       │
│ └──────────────────────────────┘ │                 │ • 100 g parmesan                 │
│ ┌──────────────────────────────┐ │                 │ • 1 bunch parsley                │
│ │ Hähnchencurry                │ │                 │ • olive oil, salt, pepper        │
│ │ last cooked 1mo ago          │ │                 │                                  │
│ └──────────────────────────────┘ │                 │ Steps                            │
│                                  │                 │ 1. Boil salted water…            │
│ — full collection —              │                 │ 2. …                             │
│ ┌──────────────────────────────┐ │                 │                                  │
│ │ Pasta al limone              │ │                 │ Source: smittenkitchen.com ↗     │
│ │ last cooked 2d ago           │ │                 │                                  │
│ └──────────────────────────────┘ │                 │                                  │
│ …                                │                 │                                  │
│                                  │                 │                                  │
│                       [+ New]    │                 │                                  │
├──────────────────────────────────┤                 ├──────────────────────────────────┤
│  Recipes  │  Kitchen             │                 │  Recipes  │  Kitchen             │
└──────────────────────────────────┘                 └──────────────────────────────────┘
```

- Search behaviour identical to desktop (DESIGN.md §4.1 → "Searching the collection").
- Empty query → full collection sorted by most-recently-used; with a query, matched recipes pinned on top with highlighted fragments, then "— full collection —" below.
- "+ Add to draft" on the detail view appends one recipe to the draft and confirms with a brief toast ("Added to draft"). Same recipe can be added again.

---

## 6. Mobile — Kitchen tab

**Purpose:** plan the shopping list and decide what to cook tonight.
Single tab, segmented control between Draft, In stock, and Ingredients.

```
MOBILE — Draft                                       MOBILE — In stock
┌──────────────────────────────────┐                ┌──────────────────────────────────┐
│ Kitchen                       ⚙  │                │ Kitchen                       ⚙  │
├──────────────────────────────────┤                ├──────────────────────────────────┤
│ [ Draft | In stock | Ingredients ]│                │ [ Draft | In stock | Ingredients ]│
│   (4)       (2)                   │                │   (4)       (2)                   │
├──────────────────────────────────┤                ├──────────────────────────────────┤
│ ┌──────────────────────────────┐ │                │ ┌──────────────────────────────┐ │
│ │ Pasta al limone              │ │                │ │ Hähnchencurry                │ │
│ │ serves [ 4 ⏶⏷]   👤 Tom     │ │                │ │ serves 4    👤 Anna          │ │
│ └──────────────────────────────┘ │                │ │                              │ │
│ ┌──────────────────────────────┐ │                │ │ [      ✓ Cooked          ]   │ │
│ │ Chicken katsu                │ │                │ └──────────────────────────────┘ │
│ │ serves [ 6 ⏶⏷]   👤 –       │ │                │ ┌──────────────────────────────┐ │
│ └──────────────────────────────┘ │                │ │ Ofengemüse                   │ │
│ ┌──────────────────────────────┐ │                │ │ serves 6    👤 –             │ │
│ │ Linsensuppe                  │ │                │ │                              │ │
│ │ serves [ 8 ⏶⏷]   👤 Anna    │ │                │ │ [      ✓ Cooked          ]   │ │
│ └──────────────────────────────┘ │                │ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │                │                                  │
│ │ Pasta al limone              │ │                │ Empty? Cook from the Draft       │
│ │ serves [ 4 ⏶⏷]   👤 –       │ │                │ tab and finalise to refill.      │
│ └──────────────────────────────┘ │                │                                  │
│                                  │                │                                  │
│ [    Finalise →              ]   │                │                                  │
├──────────────────────────────────┤                ├──────────────────────────────────┤
│  Recipes  │  Kitchen             │                │  Recipes  │  Kitchen             │
└──────────────────────────────────┘                └──────────────────────────────────┘

MOBILE — Ingredients (planned, all in-stock)
┌──────────────────────────────────┐
│ Kitchen                       ⚙  │
├──────────────────────────────────┤
│ [ Draft | In stock | Ingredients ]│
├──────────────────────────────────┤
│ Planned ingredients          🔍  │
│ ┌──────────────────────────────┐ │
│ │ 400 g spaghetti              │ │  A–Z by item name
│ │ Pasta al limone              │ │
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ 600 g tomato            2×   │ │  merges interleaved alphabetically
│ │ · 300 g tomato — Pasta …     │ │
│ │ · 300 g tomatos — Tomato …   │ │
│ └──────────────────────────────┘ │
│                                  │
│ 🔍 expands left over the title:  │
│ [ Filter…                   ]🔍  │  ← same row, no extra vertical space
├──────────────────────────────────┤
│  Recipes  │  Kitchen             │
└──────────────────────────────────┘
```

- Tapping a recipe card → **Recipe detail** (§5).
- Tapping `👤` opens a sheet to assign/clear the designated cook.
- Per-card **"+ Note"** affordance: tap → inline single-line input ("e.g. cook this on Friday"). Once set, the note shows under the recipe header with a small Edit button. Notes are kitchen-only — they do not appear on the public handoff page.
- "Finalise →" opens **Finalise confirmation** (§7) as a sheet.
- In stock: `[ ✓ Cooked ]` is a deliberately big tap target (kitchen-with-greasy-hands ergonomics). Tap → "Marked cooked. **Undo**" toast for ~5s before writing to history.
- Empty draft: shows a friendly empty state with `[ Browse recipes → ]` jumping to the Recipes tab.
- **Ingredients** lane: read-only combined list over every in-stock recipe (not just the latest finalise batch). Rows are A–Z by representative item name. A subtle search icon expands a filter **left over the “Planned ingredients” heading** (same row — no extra vertical space). After a short debounce the query hits `/kitchen/combined/search` (FTS → trigram typo fallback → embedding synonym fallback). Desktop exposes the same list via the sidebar "Ingredients" modal without a filter (browser find). Handoff (§8) still pins merged groups to the top for Split/override.

---

## 7. Finalise confirmation

**Purpose:** confirm the irreversible draft → shopping-list → in-stock transition.

```
DESKTOP (modal)                                       MOBILE (sheet)
┌──────────────────────────────────────────────┐     ┌──────────────────────────────────┐
│ Finalise this draft?                     ✕   │     │ ✕   Finalise draft               │
├──────────────────────────────────────────────┤     ├──────────────────────────────────┤
│ This will:                                   │     │ This will:                       │
│  • Move 4 recipes to In stock                │     │  • Move 4 recipes to In stock    │
│  • Empty the draft                           │     │  • Empty the draft               │
│  • Open the Bring! handoff page              │     │  • Open the Bring! handoff page  │
│                                              │     │                                  │
│ Recipes:                                     │     │ Recipes:                         │
│  · Pasta al limone (serves 4)                │     │  · Pasta al limone (serves 4)    │
│  · Chicken katsu (serves 6)                  │     │  · Chicken katsu (serves 6)      │
│  · Linsensuppe (serves 8)                    │     │  · Linsensuppe (serves 8)        │
│  · Pasta al limone (serves 4)                │     │  · Pasta al limone (serves 4)    │
│                                              │     │                                  │
│           [ Cancel ]    [ Finalise → ]       │     │ [ Cancel ]    [  Finalise →  ]   │
└──────────────────────────────────────────────┘     └──────────────────────────────────┘
```

- "Finalise →" runs the transition (DESIGN.md §4.3) and immediately opens **Bring! handoff** (§8).
- No undo. The previous draft state is gone.

---

## 8. Bring! handoff

**Purpose:** push the finalised list into Bring!. Bring! lives on your
phone, so this whole step is fundamentally a phone job — desktop's role
is to get the URL onto your phone in one move.

There is **one URL per flat** (e.g. `cookbook.app/h/<flat-id>`).
It's a single shareable page with two responsive renderings:

- **On desktop:** a "send this to your phone" card (QR + Copy link).
- **On mobile:** the per-recipe share-into-Bring! list.

Same URL, same data, different layout — opening it on your phone after
copying it from desktop just lands you on the mobile view automatically.

```
DESKTOP — handoff URL rendered as modal              MOBILE — same URL, mobile rendering
┌──────────────────────────────────────────────┐     ┌──────────────────────────────────┐
│ Send to Bring!                           ✕   │     │ ←   Send to Bring!               │
├──────────────────────────────────────────────┤     ├──────────────────────────────────┤
│ Bring! lives on your phone. Open this        │     │ Tap to share each recipe into    │
│ page on your phone to share each recipe in.  │     │ Bring!.                          │
│ ┌────────────────┬─────────────────────────┐ │     │                                  │
│ │                │                         │ │     │ ┌──────────────────────────────┐ │
│ │                │ cookbook.app/h/<flat-id>│ │     │ │ Pasta al limone (serves 4)   │ │
│ │     [ QR ]     │                         │ │     │ │ [   Share into Bring! →  ]   │ │
│ │                │ [ Copy link ]           │ │     │ │ [ Done ]                     │ │
│ │                │                         │ │     │ └──────────────────────────────┘ │
│ │                │ Scan, AirDrop, or copy- │ │     │ ┌──────────────────────────────┐ │
│ │                │ paste — whatever's      │ │     │ │ Chicken katsu (serves 6)     │ │
│ │                │ easiest.                │ │     │ │ [   Share into Bring! →  ]   │ │
│ └────────────────┴─────────────────────────┘ │     │ │ [ Done ]                     │ │
│                                              │     │ └──────────────────────────────┘ │
│                                              │     │ ┌──────────────────────────────┐ │
│                                  [ Close ]   │     │ │ Linsensuppe (serves 8)       │ │
│                                              │     │ │ [   Share into Bring! →  ]   │ │
└──────────────────────────────────────────────┘     │ │ [ Done ]                     │ │
                                                     │ └──────────────────────────────┘ │
                                                     │                                  │
                                                     │ All sent? [ Close ]              │
                                                     └──────────────────────────────────┘
```

- After Finalise (§7), desktop opens this URL as a modal automatically; mobile navigates to it as a full page.
- Pick whichever cross-device transfer is easiest on the day: scan the QR, AirDrop the URL from the Copy button, paste from clipboard sync, etc.
- Each per-recipe `[ Share into Bring! → ]` opens the OS share sheet; Bring! registers as a share target and scrapes the per-recipe page (schema.org Recipe JSON-LD scaled to the chosen quantity, DESIGN.md §4.4).
- "Done" greys out a row so you can keep track during shopping prep. Closing with un-Done rows is fine; this UI is non-blocking.
- The handoff URL is stable for the life of the flat — it always shows the flat's current in-stock lane. You can keep it bookmarked, re-open it from your messages later, etc. After the next finalise, the same URL just shows the new contents. No "resume handoff" flow needed.

---

## 9. Flat settings (members + invite)

**Purpose:** see the flat, invite a new member. Opens from the **⚙** menu.

```
DESKTOP (modal)                                       MOBILE (full-screen)
┌──────────────────────────────────────────────┐     ┌──────────────────────────────────┐
│ Flat: Wohnung 3                          ✕   │     │ ←  Wohnung 3                     │
├──────────────────────────────────────────────┤     ├──────────────────────────────────┤
│ Members                                      │     │ Members                          │
│  · Anna       anna@example.com               │     │  · Anna                          │
│  · Tom        tom@example.com                │     │    anna@example.com              │
│  · Mira       mira@example.com               │     │  · Tom                           │
│                                              │     │    tom@example.com               │
│ Invite                                       │     │  · Mira                          │
│ ┌──────────────────────────────────────────┐ │     │    mira@example.com              │
│ │ cookbook.app/invite/8f3a-…  [ Copy ]     │ │     │                                  │
│ └──────────────────────────────────────────┘ │     │ Invite                           │
│ Anyone with this link can join your flat.    │     │ ┌──────────────────────────────┐ │
│ [ Generate new link ]                        │     │ │ cookbook.app/invite/8f3a-…   │ │
│                                              │     │ │              [ Copy ]        │ │
│ Account                                      │     │ └──────────────────────────────┘ │
│ [ Sign out ]                                 │     │ [ Generate new link ]            │
│                                              │     │                                  │
│ MCP                                          │     │ Account                          │
│ ┌──────────────────────────────────────────┐ │     │ [ Sign out ]                     │
│ │ cookbook.app/mcp            [ Copy ]     │ │     │                                  │
│ └──────────────────────────────────────────┘ │     │ MCP                              │
│ Use this URL to add cookbook as a custom     │     │ ┌──────────────────────────────┐ │
│ connector in Claude.                         │     │ │ cookbook.app/mcp             │ │
│                                              │     │ │              [ Copy ]        │ │
└──────────────────────────────────────────────┘     │ └──────────────────────────────┘ │
                                                     │ Use this URL to add cookbook     │
                                                     │ as a custom connector in Claude. │
                                                     └──────────────────────────────────┘
```

- No roles, no remove-member, no rename-flat in v1 (DESIGN.md §5).
- "Generate new link" invalidates the previous one.
- Sign out lives one level up, in the **⚙** menu itself, not on this screen.
  *(Account block here is a placeholder for the current implementation;
  it will move into the ⚙ menu when that lands.)*
- **MCP block** surfaces the server's MCP endpoint so it can be wired
  into an LLM client. "Claude" links to Anthropic's docs on adding a
  custom connector — no auto-install button (no stable deep-link
  scheme exists upstream).

---

## 10. Sidebar collapsed state (desktop)

**Purpose:** give the main pane more room without losing visibility into Draft and In stock.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ cookbook                                              Anna · Flat: Wohnung 3        ⚙  │
├────────────────────────────────────────────────────────────────────────────────────┬────┤
│ ← Collection                                                                       │  » │
│                                                                                    │    │
│ Pasta al limone                                                            [Edit]  │ D  │
│                                                                                    │ 4  │
│ ┌────────────────────────────────────┐                                             │    │
│ │            [photo]                 │                                             │ S  │
│ └────────────────────────────────────┘                                             │ 2  │
│                                                                                    │    │
│ Base: serves 4                                                                     │    │
│                                                                                    │    │
│ [ + Add to draft ]                                                                 │    │
│                                                                                    │    │
│ Ingredients (serves 4)                                                             │    │
│ • 400 g spaghetti                                                                  │    │
│ • 2 lemons                                                                         │    │
│ • …                                                                                │    │
└────────────────────────────────────────────────────────────────────────────────────┴────┘
```

- Thin rail shows two counters: `D 4` (draft size) · `S 2` (in stock size).
- Clicking the rail (or `»`) re-expands the sidebar.
- Counters update live; if the draft gets a new entry via "+ Add to draft", the `D` counter pulses briefly to acknowledge.
