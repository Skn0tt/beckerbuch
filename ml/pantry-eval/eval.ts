/**
 * Pantry cosine eval on vectors already cached in production.
 *
 * Each pair is two `ingredient_embeddings` texts for
 * `gemini-embedding-001`. `drop` means a pantry entry of `pantry`
 * should hide `item` (same staple, more specific wording). `keep`
 * means the line is a different food and must stay on the shopping
 * list. Scores were read from the production cache on 2026-11-15.
 * `node scripts/pantry-eval.mjs` recomputes them when DATABASE_URL is set.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PantryEvalExpect = "drop" | "keep";

export type PantryEvalPair = {
  expect: PantryEvalExpect;
  pantry: string;
  item: string;
  cosine: number;
};

export type PantryEvalFile = {
  model: string;
  measured: string;
  source: string;
  pairs: PantryEvalPair[];
};

export const pantryEval: PantryEvalFile = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "pairs.json"),
    "utf8",
  ),
);

export function pantryEvalMistakes(threshold: number): {
  falseKeeps: PantryEvalPair[];
  falseDrops: PantryEvalPair[];
} {
  const falseKeeps: PantryEvalPair[] = [];
  const falseDrops: PantryEvalPair[] = [];
  for (const pair of pantryEval.pairs) {
    const drops = pair.cosine >= threshold;
    if (pair.expect === "drop" && !drops) falseKeeps.push(pair);
    if (pair.expect === "keep" && drops) falseDrops.push(pair);
  }
  return { falseKeeps, falseDrops };
}

/** Thresholds in [from, to] at `step` with no false keeps and no false drops. */
export function cleanPantryThresholds(
  from = 0.8,
  to = 0.99,
  step = 0.01,
): number[] {
  const clean: number[] = [];
  const start = Math.round(from / step);
  const end = Math.round(to / step);
  for (let i = start; i <= end; i++) {
    const threshold = Math.round(i * step * 1000) / 1000;
    const { falseKeeps, falseDrops } = pantryEvalMistakes(threshold);
    if (falseKeeps.length === 0 && falseDrops.length === 0) {
      clean.push(threshold);
    }
  }
  return clean;
}
