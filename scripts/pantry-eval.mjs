/**
 * Recompute ml/pantry-eval/pairs.json against ingredient_embeddings.
 *
 *   DATABASE_URL=... node scripts/pantry-eval.mjs
 *
 * Prints each pair whose cosine moved by more than 0.002, then exits
 * non-zero if any did. Does not write the file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DB_URL;
if (!url) {
  console.error("Set DATABASE_URL to the database that holds ingredient_embeddings.");
  process.exit(1);
}

const pairsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../ml/pantry-eval/pairs.json",
);
const file = JSON.parse(readFileSync(pairsPath, "utf8"));
const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query(
  "select text, embedding::text as embedding from ingredient_embeddings where model = $1",
  [file.model],
);
await client.end();

const norm = (text) => text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
const byKey = new Map(
  rows.map((row) => [norm(row.text), JSON.parse(row.embedding)]),
);

let drifted = 0;
for (const pair of file.pairs) {
  const left = byKey.get(norm(pair.pantry));
  const right = byKey.get(norm(pair.item));
  if (!left || !right) {
    drifted++;
    console.log(`missing\t${pair.pantry}\t${pair.item}`);
    continue;
  }
  const score = cosine(left, right);
  const delta = Math.abs(score - pair.cosine);
  if (delta > 0.002) {
    drifted++;
    console.log(
      `${pair.expect}\t${pair.cosine.toFixed(4)} -> ${score.toFixed(4)}\t${pair.pantry} -> ${pair.item}`,
    );
  }
}
console.log(
  drifted === 0
    ? `${file.pairs.length} pairs match the cache within 0.002`
    : `${drifted} pairs drifted`,
);
process.exit(drifted === 0 ? 0 : 1);
