import { parseAmount } from "./amount";
import { formatIngredient } from "./scale";
import type { KitchenEntry } from "./kitchen-data";

export type PlannedIngredient = {
  /** Display item name (taken from the first contributing source). */
  item: string;
  /** Unit as displayed; null when ingredient is unitless. */
  unit: string | null;
  /** Pre-formatted line for the UI. */
  displayText: string;
  /** Contributing recipe names, deduped, preserving first-seen order. */
  recipes: string[];
};

type Bucket = {
  item: string;
  unit: string | null;
  total: number | null;
  /** True once any contribution had a non-parseable amount. */
  unsummable: boolean;
  recipes: string[];
};

/**
 * Group ingredients across in-stock recipe instances so the flat can
 * see what food is still reserved by uncooked recipes. Amounts are
 * scaled by each instance's target/base factor and summed when every
 * contribution shares the same unit and has a parseable amount.
 *
 * Grouping key is `(item lowercased + trimmed, unit lowercased + trimmed)`.
 * Items that don't share a unit don't merge.
 */
export function planIngredients(
  entries: KitchenEntry[],
): PlannedIngredient[] {
  const buckets = new Map<string, Bucket>();

  for (const entry of entries) {
    const factor =
      entry.baseQuantity > 0 ? entry.targetQuantity / entry.baseQuantity : 1;
    for (const ing of entry.ingredients) {
      const itemKey = ing.item.trim().toLowerCase();
      if (itemKey === "") continue;
      const unitKey = (ing.unit ?? "").trim().toLowerCase();
      const key = `${itemKey}\u0000${unitKey}`;
      const parsed = parseAmount(ing.amount);
      const scaled = parsed === null ? null : parsed * factor;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          item: ing.item.trim(),
          unit: ing.unit?.trim() ? ing.unit.trim() : null,
          total: scaled,
          unsummable: scaled === null,
          recipes: [],
        };
        buckets.set(key, bucket);
      } else {
        if (scaled === null) {
          bucket.unsummable = true;
        } else if (bucket.total !== null) {
          bucket.total += scaled;
        }
      }
      if (!bucket.recipes.includes(entry.recipeName)) {
        bucket.recipes.push(entry.recipeName);
      }
    }
  }

  return [...buckets.values()]
    .map((b) => {
      const amount =
        b.unsummable || b.total === null ? null : formatAmount(b.total);
      const displayText = formatIngredient(
        { amount, unit: b.unit, item: b.item },
        1,
      );
      return {
        item: b.item,
        unit: b.unit,
        displayText,
        recipes: b.recipes,
      };
    })
    .sort((a, b) =>
      a.item.localeCompare(b.item, undefined, { sensitivity: "base" }),
    );
}

function formatAmount(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(2)).toString();
}
