/**
 * Embedding-based deduplication of shopping-list ingredients across
 * recipes (issues #7, #63).
 *
 * We embed each ingredient's *item* text, cluster the items by cosine
 * similarity, and treat each cluster as a set of lines referring to the
 * same ingredient. All unit-compat checking, amount arithmetic, and
 * display formatting happens in the shared {@link postProcess} below,
 * so clustering's only job is producing the groupings.
 *
 * Embeddings are cached in the `ingredient_embeddings` table (see
 * {@link embedTexts}) so we don't re-pay/re-wait across recipes and
 * flats. In tests the network is intercepted by `tests/proxy/`, so this
 * module always calls the real embedding provider in shape; the proxy
 * responds with deterministic vectors during npm test.
 */
import { randomUUID } from "node:crypto";
import type { DedupGroup } from "../db/schema";
import { parseAmount } from "./amount";
import { formatIngredient } from "./scale";
import { clusterBySimilarity, embedTexts } from "./embeddings";

export type DedupInputItem = {
  /** Stable id within this dedup call (we use ingredient row id). */
  id: string;
  amount: string | null;
  unit: string | null;
  item: string;
  recipeName: string;
};

export type DedupInput = {
  items: DedupInputItem[];
};

/** Minimal contract fed into {@link postProcess}: which ids merge. */
export type RawMerges = {
  merges: { ids: string[] }[];
};

export type DedupResult = {
  groups: DedupGroup[];
  /** Identifier of the backend that produced this result. */
  model: string;
};

/**
 * Anything bigger than this skips embeddings entirely and returns all
 * singletons. A shopping list is the union across a flat's planned
 * recipes, so it can be large; the guard only exists to bound worst-case
 * O(n²) clustering + the embedding request. Override via MAX_INPUT_ITEMS.
 */
const MAX_INPUT_ITEMS = Number(process.env.MAX_INPUT_ITEMS ?? 5000);

/** Default embedding model; override via DEDUP_EMBEDDING_MODEL. */
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Cosine-similarity threshold for treating two ingredient texts as the
 * same thing. Re-tuned for gemini-embedding-001 (SEMANTIC_SIMILARITY
 * task, 1024 dims) on a gold set derived from real prod ingredient
 * texts (see `ml/embedding-eval/`): 0.95 is the lowest cutoff that
 * produces zero hard-negative violations (Paprika vs Paprikapulver,
 * Zitrone vs Limette, Parmesan vs Pecorino stay apart) while still
 * catching the near-dup families — including cross-lingual pairs and
 * German synonyms (Möhren/Karotten) that the previous OpenAI model
 * collapsed or missed. Gemini runs "hot" (mean cosine is high even for
 * unrelated pairs), so this threshold is much higher than the old
 * text-embedding-3-small value of 0.82 — do not compare the two numbers
 * directly; they live on different scales. Override via
 * DEDUP_SIMILARITY_THRESHOLD.
 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.95;

// ---------------------------------------------------------------------------
// Unit compatibility table.
//
// Keys are lowercased units (with common synonyms normalised). Each entry
// declares the "family" (so units in the same family can be summed) and
// the multiplier from the unit to a canonical *base* unit within that
// family. We sum in the base unit, then choose a display unit that keeps
// the number readable.
// ---------------------------------------------------------------------------

type UnitFamily = string;

type UnitInfo = {
  family: UnitFamily;
  /** Multiplier from this unit to the family's base unit. */
  toBase: number;
  /** Display name for this unit, used when we pick a display unit. */
  display: string;
};

const UNIT_TABLE: Record<string, UnitInfo> = {
  // Mass — base = g
  g: { family: "mass", toBase: 1, display: "g" },
  gr: { family: "mass", toBase: 1, display: "g" },
  gram: { family: "mass", toBase: 1, display: "g" },
  grams: { family: "mass", toBase: 1, display: "g" },
  kg: { family: "mass", toBase: 1000, display: "kg" },
  // Volume — base = ml
  ml: { family: "volume", toBase: 1, display: "ml" },
  l: { family: "volume", toBase: 1000, display: "l" },
  liter: { family: "volume", toBase: 1000, display: "l" },
  liters: { family: "volume", toBase: 1000, display: "l" },
  litre: { family: "volume", toBase: 1000, display: "l" },
  litres: { family: "volume", toBase: 1000, display: "l" },
  // Teaspoon family — base = tsp (3 tsp = 1 tbsp).
  tsp: { family: "tsp_tbsp", toBase: 1, display: "tsp" },
  teaspoon: { family: "tsp_tbsp", toBase: 1, display: "tsp" },
  teaspoons: { family: "tsp_tbsp", toBase: 1, display: "tsp" },
  tbsp: { family: "tsp_tbsp", toBase: 3, display: "tbsp" },
  tablespoon: { family: "tsp_tbsp", toBase: 3, display: "tbsp" },
  tablespoons: { family: "tsp_tbsp", toBase: 3, display: "tbsp" },
};

function unitInfo(unit: string | null): UnitInfo {
  if (unit === null || unit.trim() === "") {
    return { family: "count", toBase: 1, display: "" };
  }
  const key = unit.trim().toLowerCase();
  const found = UNIT_TABLE[key];
  if (found) return found;
  // Unknown unit: treat as its own family so it never silently merges
  // with another unknown unit, but still merges with itself.
  return { family: "u:" + key, toBase: 1, display: unit };
}

function formatAmount(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Number(n.toFixed(2)).toString();
}

// ---------------------------------------------------------------------------
// Display item name picking — deterministic across model versions.
//
// Strategy: count occurrences case-insensitively; pick the most-frequent
// item string. Ties break on shortest length (so "tomato" beats
// "tomatos"); further ties break on first appearance.
// ---------------------------------------------------------------------------

function pickItemName(sources: DedupInputItem[]): string {
  const counts = new Map<string, { count: number; sample: string; firstIndex: number }>();
  for (let i = 0; i < sources.length; i++) {
    const item = sources[i].item;
    const key = item.toLowerCase();
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
    } else {
      counts.set(key, { count: 1, sample: item, firstIndex: i });
    }
  }
  let best: { count: number; sample: string; firstIndex: number } | null = null;
  for (const entry of counts.values()) {
    if (
      best === null ||
      entry.count > best.count ||
      (entry.count === best.count && entry.sample.length < best.sample.length) ||
      (entry.count === best.count &&
        entry.sample.length === best.sample.length &&
        entry.firstIndex < best.firstIndex)
    ) {
      best = entry;
    }
  }
  return best!.sample;
}

// ---------------------------------------------------------------------------
// Group construction.
// ---------------------------------------------------------------------------

function singletonGroup(item: DedupInputItem): DedupGroup {
  const displayText = formatIngredient(
    { amount: item.amount, unit: item.unit, item: item.item },
    1,
  );
  return {
    id: randomUUID(),
    item: item.item,
    unit: item.unit,
    amount: item.amount,
    displayText,
    sources: [
      { id: item.id, displayText, recipeName: item.recipeName },
    ],
  };
}

/**
 * Build a merged group from a unit-compatible set of input items.
 * Caller guarantees that {@link compatibleUnits} returns true for the
 * inputs' units.
 */
function mergedGroup(items: DedupInputItem[]): DedupGroup {
  // Pick a canonical display unit — the smallest one in the family,
  // i.e. the unit with toBase = 1. Falls back to first unit if none
  // qualifies (unknown units always have toBase = 1 anyway).
  let displayUnit: string | null = items[0].unit;
  let displayUnitInfo = unitInfo(displayUnit);
  for (const it of items) {
    const info = unitInfo(it.unit);
    if (info.toBase < displayUnitInfo.toBase) {
      displayUnit = it.unit;
      displayUnitInfo = info;
    }
  }

  // Sum amounts in the base unit. If any amount is null, the merged
  // amount is null too — we still dedupe the name.
  let totalBase: number | null = 0;
  for (const it of items) {
    const parsed = parseAmount(it.amount);
    if (parsed === null) {
      totalBase = null;
      break;
    }
    totalBase += parsed * unitInfo(it.unit).toBase;
  }
  const summedDisplay =
    totalBase === null ? null : formatAmount(totalBase / displayUnitInfo.toBase);

  const itemName = pickItemName(items);
  const displayText = formatIngredient(
    { amount: summedDisplay, unit: displayUnit, item: itemName },
    1,
  );

  return {
    id: randomUUID(),
    item: itemName,
    unit: displayUnit,
    amount: summedDisplay,
    displayText,
    sources: items.map((it) => ({
      id: it.id,
      displayText: formatIngredient(
        { amount: it.amount, unit: it.unit, item: it.item },
        1,
      ),
      recipeName: it.recipeName,
    })),
  };
}

// ---------------------------------------------------------------------------
// Post-processor — takes raw merges and the original input, returns the
// final list of DedupGroups (including singletons for unmerged ids).
//
// Defensively splits incompatible-unit merges and drops nonsense
// suggestions (unknown ids, ids in multiple merges). Never throws on
// bad input — always returns a usable result.
// ---------------------------------------------------------------------------

export function postProcess(
  input: DedupInput,
  raw: RawMerges,
): DedupGroup[] {
  const byId = new Map<string, DedupInputItem>();
  for (const item of input.items) byId.set(item.id, item);

  const seen = new Set<string>();
  const groups: DedupGroup[] = [];

  for (const merge of raw.merges) {
    if (!Array.isArray(merge?.ids)) continue;
    // De-dupe ids within a single merge, drop unknowns and previously
    // claimed ids.
    const claimedIds: string[] = [];
    const claimedItems: DedupInputItem[] = [];
    for (const id of merge.ids) {
      if (typeof id !== "string") continue;
      if (seen.has(id)) continue;
      const item = byId.get(id);
      if (!item) continue;
      if (claimedIds.includes(id)) continue;
      claimedIds.push(id);
      claimedItems.push(item);
    }
    if (claimedItems.length === 0) continue;
    if (claimedItems.length === 1) {
      // Singleton merges are meaningless — let it fall through to the
      // singleton pass below.
      continue;
    }

    // Split by unit family. Items whose unit family matches the first
    // claimed item stay merged; the rest get retried as their own
    // sub-merge (recursive style, but bounded by family count).
    const buckets = new Map<string, DedupInputItem[]>();
    for (const it of claimedItems) {
      const family = unitInfo(it.unit).family;
      const list = buckets.get(family) ?? [];
      list.push(it);
      buckets.set(family, list);
    }

    for (const bucket of buckets.values()) {
      if (bucket.length === 1) {
        groups.push(singletonGroup(bucket[0]));
      } else {
        groups.push(mergedGroup(bucket));
      }
      for (const it of bucket) seen.add(it.id);
    }
  }

  // Singletons for everything not covered by a merge.
  for (const item of input.items) {
    if (seen.has(item.id)) continue;
    groups.push(singletonGroup(item));
    seen.add(item.id);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Embedding backend + public entry point.
// ---------------------------------------------------------------------------

/**
 * Embed every item text, cluster by cosine similarity, and return the
 * clusters as `{ merges }`. Singletons are omitted — postProcess fills
 * them in.
 */
async function clusterByEmbedding(
  input: DedupInput,
  model: string,
  threshold: number,
): Promise<RawMerges> {
  const texts = input.items.map((it) => it.item);
  const byText = await embedTexts(model, texts);
  const embeddings = input.items.map((it) => byText.get(it.item));

  const clusters = clusterBySimilarity(embeddings, threshold);
  const merges: { ids: string[] }[] = [];
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    merges.push({ ids: cluster.map((i) => input.items[i].id) });
  }
  return { merges };
}

export async function dedup(input: DedupInput): Promise<DedupResult> {
  // Nothing to dedupe.
  if (input.items.length === 0) {
    return { groups: [], model: "none" };
  }
  // Too big — skip embeddings and return all singletons.
  if (input.items.length > MAX_INPUT_ITEMS) {
    return {
      groups: input.items.map(singletonGroup),
      model: "none:too_large",
    };
  }

  const model = process.env.DEDUP_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const threshold = Number(
    process.env.DEDUP_SIMILARITY_THRESHOLD ?? DEFAULT_SIMILARITY_THRESHOLD,
  );
  const backendName = `embedding:${model}`;

  let raw: RawMerges;
  try {
    raw = await clusterByEmbedding(input, model, threshold);
  } catch (err) {
    console.warn(
      `[dedup] backend ${backendName} failed, falling back to no-merge:`,
      err,
    );
    return {
      groups: input.items.map(singletonGroup),
      model: `${backendName}:failed`,
    };
  }

  const groups = postProcess(input, raw);
  return { groups, model: backendName };
}

/**
 * Stable hash of the dedup input — used to detect post-finalise
 * staleness when recipes are edited.
 */
export async function hashInput(input: DedupInput): Promise<string> {
  const { createHash } = await import("node:crypto");
  // Sort by id so order doesn't affect the hash.
  const stable = [...input.items].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
