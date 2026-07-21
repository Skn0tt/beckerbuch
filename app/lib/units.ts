/**
 * Unit normalization, compatibility families, and amount summing for
 * shopping-list dedup (see {@link ./dedup.ts}).
 *
 * Design goals:
 * - Sum whenever units are *known-convertible* (same family).
 * - Never silently cross families (mass ≠ volume, pinch ≠ tsp).
 * - Prefer a readable display unit after summing in a canonical base.
 *
 * Conversion assumptions (documented, not locale-detected):
 * - US legal cup = 240 ml
 * - 1 oz = 28.3495 g; 1 lb = 453.592 g
 * - 1 tbsp = 3 tsp
 */
import { parseAmount } from "./amount";

/** Compatibility family — units in the same family may be summed. */
export type UnitFamily = string;

export type UnitInfo = {
  family: UnitFamily;
  /** Multiplier from this unit to the family's base unit. */
  toBase: number;
  /** Canonical display name for this unit. */
  display: string;
};

export type AmountUnit = {
  amount: string | null;
  unit: string | null;
};

// ---------------------------------------------------------------------------
// Conversion constants
// ---------------------------------------------------------------------------

const OZ_TO_G = 28.3495;
const LB_TO_G = 453.592;
const US_CUP_TO_ML = 240;
const TBSP_TO_TSP = 3;

/**
 * Synonym / plural map → canonical lookup key before UNIT_TABLE.
 * Keys are already lowercased and trimmed.
 */
const UNIT_ALIASES: Record<string, string> = {
  // Mass
  gr: "g",
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  // Metric volume
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  // US volume
  cups: "cup",
  tasse: "cup",
  tassen: "cup",
  pints: "pint",
  quarts: "quart",
  gallons: "gallon",
  // Spoons (incl. German)
  teaspoon: "tsp",
  teaspoons: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tl: "tsp",
  el: "tbsp",
  // Qualitative (exact-match families after canonicalisation)
  pinches: "pinch",
  prisen: "pinch",
  prise: "pinch",
  dashes: "dash",
  cloves: "clove",
  slices: "slice",
  scheibe: "slice",
  scheiben: "slice",
  cans: "can",
  dose: "can",
  dosen: "can",
  jars: "jar",
  sticks: "stick",
  packages: "package",
  packungen: "package",
  packung: "package",
  pkg: "package",
  stück: "stück",
  stk: "stück",
};

/**
 * Known convertible units. Family is the compatibility bucket; toBase is
 * relative to that family's base (g, ml, or tsp).
 */
const UNIT_TABLE: Record<string, UnitInfo> = {
  // Mass — base = g
  g: { family: "mass", toBase: 1, display: "g" },
  kg: { family: "mass", toBase: 1000, display: "kg" },
  mg: { family: "mass", toBase: 0.001, display: "mg" },
  oz: { family: "mass", toBase: OZ_TO_G, display: "oz" },
  lb: { family: "mass", toBase: LB_TO_G, display: "lb" },

  // Volume — base = ml (metric + US share one family so cup+ml can sum)
  ml: { family: "volume", toBase: 1, display: "ml" },
  cl: { family: "volume", toBase: 10, display: "cl" },
  dl: { family: "volume", toBase: 100, display: "dl" },
  l: { family: "volume", toBase: 1000, display: "l" },
  cup: { family: "volume", toBase: US_CUP_TO_ML, display: "cup" },
  pint: { family: "volume", toBase: US_CUP_TO_ML * 2, display: "pint" },
  quart: { family: "volume", toBase: US_CUP_TO_ML * 4, display: "quart" },
  gallon: { family: "volume", toBase: US_CUP_TO_ML * 16, display: "gallon" },

  // Spoons — base = tsp
  tsp: { family: "tsp_tbsp", toBase: 1, display: "tsp" },
  tbsp: { family: "tsp_tbsp", toBase: TBSP_TO_TSP, display: "tbsp" },
};

/** Qualitative units: each canonical key is its own family (`q:<key>`). */
const QUALITATIVE = new Set([
  "pinch",
  "dash",
  "clove",
  "slice",
  "can",
  "jar",
  "stick",
  "package",
  "bund",
  "stück",
]);

const METRIC_VOLUME = new Set(["ml", "cl", "dl", "l"]);
const US_VOLUME = new Set(["cup", "pint", "quart", "gallon"]);

/**
 * Trim, lowercase, strip a trailing period, then apply synonym aliases.
 * Empty / null → null (count).
 */
export function normalizeUnit(raw: string | null): string | null {
  if (raw === null) return null;
  const key = raw.trim().toLowerCase().replace(/\.$/, "");
  if (key === "") return null;
  return UNIT_ALIASES[key] ?? key;
}

/**
 * Resolve a raw unit string to conversion info used for summing / display.
 */
export function unitInfo(unit: string | null): UnitInfo {
  const key = normalizeUnit(unit);
  if (key === null) {
    return { family: "count", toBase: 1, display: "" };
  }
  const found = UNIT_TABLE[key];
  if (found) return found;
  if (QUALITATIVE.has(key)) {
    return { family: "q:" + key, toBase: 1, display: key };
  }
  // Unknown: own family so it never merges with a different unknown.
  return { family: "u:" + key, toBase: 1, display: key };
}

/** Compatibility family for bucketing (mass / volume / tsp_tbsp / …). */
export function unitFamily(unit: string | null): UnitFamily {
  return unitInfo(unit).family;
}

export function formatAmount(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(2)).toString();
}

/** Convert a parsed amount into the family's base unit. Null if unparseable. */
export function toBaseAmount(
  amount: string | null,
  unit: string | null,
): number | null {
  const parsed = parseAmount(amount);
  if (parsed === null) return null;
  return parsed * unitInfo(unit).toBase;
}

/** Convert a base-unit total into the given display unit. */
export function fromBaseAmount(totalBase: number, unit: string | null): number {
  const info = unitInfo(unit);
  return totalBase / info.toBase;
}

function isCleanNumber(n: number): boolean {
  if (Number.isInteger(n)) return true;
  // One decimal place (e.g. 1.5 kg) counts as readable.
  return Number.isInteger(Math.round(n * 10));
}

function pluralizeDisplay(canonical: string, amount: number): string {
  if (amount === 1) return canonical;
  // Abbreviations stay as-is.
  if (
    canonical === "g" ||
    canonical === "kg" ||
    canonical === "mg" ||
    canonical === "ml" ||
    canonical === "cl" ||
    canonical === "dl" ||
    canonical === "l" ||
    canonical === "oz" ||
    canonical === "lb" ||
    canonical === "tsp" ||
    canonical === "tbsp"
  ) {
    return canonical;
  }
  if (canonical === "cup") return "cups";
  if (canonical === "pint") return "pints";
  if (canonical === "quart") return "quarts";
  if (canonical === "gallon") return "gallons";
  if (canonical.endsWith("s") || canonical.endsWith("ch")) {
    // pinch → pinches; already-plural or awkward stems keep the key.
    if (canonical === "pinch") return "pinches";
    if (canonical === "dash") return "dashes";
    return canonical;
  }
  return canonical + "s";
}

/**
 * Choose a readable display unit + formatted amount after summing in base.
 *
 * Rules (deterministic):
 * - mass: prefer kg when ≥ 1000 g and the kg figure is "clean"
 * - volume: prefer l when ≥ 1000 ml and clean; prefer whole cups when
 *   every source was US volume (no ml/l/cl/dl) and the total is a whole
 *   number of cups; otherwise ml
 * - tsp_tbsp: prefer tbsp when total tsp is a multiple of 3 and ≥ 3
 * - otherwise family base (g / ml / tsp) or the qualitative/unknown unit
 */
export function pickReadableDisplay(
  totalBase: number,
  family: UnitFamily,
  sourceUnits: (string | null)[],
): AmountUnit {
  const sourceKeys = sourceUnits.map((u) => normalizeUnit(u));

  if (family === "mass") {
    const kg = totalBase / 1000;
    if (totalBase >= 1000 && isCleanNumber(kg)) {
      return { amount: formatAmount(kg), unit: "kg" };
    }
    // Prefer oz/lb when all sources were imperial and that yields an integer.
    const allImperial = sourceKeys.every((k) => k === "oz" || k === "lb");
    if (allImperial && sourceKeys.length > 0) {
      const lb = totalBase / LB_TO_G;
      if (Number.isInteger(lb) || isCleanNumber(lb)) {
        return { amount: formatAmount(lb), unit: "lb" };
      }
      const oz = totalBase / OZ_TO_G;
      if (Number.isInteger(Math.round(oz * 100) / 100) && isCleanNumber(oz)) {
        return { amount: formatAmount(oz), unit: "oz" };
      }
    }
    return { amount: formatAmount(totalBase), unit: "g" };
  }

  if (family === "volume") {
    const liters = totalBase / 1000;
    if (totalBase >= 1000 && isCleanNumber(liters)) {
      return { amount: formatAmount(liters), unit: "l" };
    }
    const anyMetric = sourceKeys.some((k) => k !== null && METRIC_VOLUME.has(k));
    const allUs =
      sourceKeys.length > 0 &&
      sourceKeys.every((k) => k !== null && US_VOLUME.has(k));
    const cups = totalBase / US_CUP_TO_ML;
    if (!anyMetric && allUs && Number.isInteger(cups)) {
      const display = pluralizeDisplay("cup", cups);
      return { amount: formatAmount(cups), unit: display };
    }
    return { amount: formatAmount(totalBase), unit: "ml" };
  }

  if (family === "tsp_tbsp") {
    if (totalBase >= TBSP_TO_TSP && totalBase % TBSP_TO_TSP === 0) {
      return { amount: formatAmount(totalBase / TBSP_TO_TSP), unit: "tbsp" };
    }
    return { amount: formatAmount(totalBase), unit: "tsp" };
  }

  if (family === "count") {
    return { amount: formatAmount(totalBase), unit: null };
  }

  // Qualitative / unknown: single unit in the family; pluralize display.
  const info = unitInfo(sourceUnits[0] ?? null);
  const display = pluralizeDisplay(info.display || info.family.replace(/^[qu]:/, ""), totalBase);
  return { amount: formatAmount(totalBase), unit: display || null };
}

/**
 * Sum amounts for a unit-compatible list (caller guarantees same family).
 * If any amount is null/unparseable, the merged amount is null — we still
 * return a sensible display unit from the sources.
 */
export function sumCompatibleAmounts(items: AmountUnit[]): AmountUnit {
  if (items.length === 0) {
    return { amount: null, unit: null };
  }

  const family = unitFamily(items[0].unit);
  let totalBase: number | null = 0;
  for (const it of items) {
    const base = toBaseAmount(it.amount, it.unit);
    if (base === null) {
      totalBase = null;
      break;
    }
    totalBase += base;
  }

  if (totalBase === null) {
    // Keep a display unit from the first item (or empty for count).
    const info = unitInfo(items[0].unit);
    return {
      amount: null,
      unit: info.display === "" ? null : info.display,
    };
  }

  return pickReadableDisplay(
    totalBase,
    family,
    items.map((it) => it.unit),
  );
}
