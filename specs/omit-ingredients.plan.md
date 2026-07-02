# Omit ingredients from a recipe (issue #70)

While a recipe is **drafted**, a user can mark a subset of its
ingredients as **omitted**. Omitted ingredients render struck-through on
the recipe page (drafted only) and are excluded from the Bring! export
at finalisation.

## Behaviour under test

- **Toggle on a drafted recipe**: after adding a recipe to the draft,
  each ingredient line on the recipe page has a shopping-cart toggle.
  Clicking "Omit <item>" strikes the line through and flips the control
  to "Include <item>". Clicking again restores it.
- **No toggle when not drafted**: a recipe that has never been added to a
  draft renders the plain ingredient list — no cart toggle.
- **No toggle / no strike once in stock**: after finalising the draft,
  the recipe page renders ingredients plainly — no cart toggle, no
  strike-through — even for an ingredient that was omitted while drafted.
- **Excluded from the shopping list**: an ingredient omitted while
  drafted does not appear in the combined shopping list nor the JSON-LD
  on `/h/:flatId` after finalising; non-omitted ingredients still do.
- **Edit-identity regression**: omitting an ingredient, then editing an
  unrelated field of the recipe, keeps the omission in effect (proves
  ingredient UUIDs are stable across edits).
