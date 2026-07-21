import { sql } from "drizzle-orm";
import type { db as dbFactory } from "./db/client";
import { ingredients, recipes } from "./db/schema";

type Tx = Parameters<Parameters<ReturnType<typeof dbFactory>["transaction"]>[0]>[0];

/**
 * Recompute and persist `recipes.search_vector` for one recipe by joining its
 * own row + the (already-inserted) ingredients table, and each ingredient's
 * own `search_vector` from its `item` text. Called inside the same transaction
 * that wrote the recipe / ingredients, so the new content is already visible.
 *
 * Recipe weight tiers (per TECH.md §5.1):
 *   A — name
 *   B — ingredient items (concatenated)
 *   C — source_host
 *   D — steps
 *
 * Ingredient vectors use the same `simple` + `unaccent` config so planned-
 * ingredients FTS matches recipe search tokenization.
 */
export async function updateSearchVector(tx: Tx, recipeId: string): Promise<void> {
  await tx.execute(sql`
    update ${recipes} as r
    set search_vector =
        setweight(to_tsvector('simple', unaccent(coalesce(r.name, ''))), 'A')
      || setweight(
           to_tsvector(
             'simple',
             unaccent(coalesce(
               (select string_agg(i.item, ' ') from ingredients i where i.recipe_id = r.id),
               ''
             ))
           ),
           'B'
         )
      || setweight(to_tsvector('simple', unaccent(coalesce(r.source_host, ''))), 'C')
      || setweight(to_tsvector('simple', unaccent(coalesce(r.steps, ''))), 'D')
    where r.id = ${recipeId}
  `);

  await tx.execute(sql`
    update ${ingredients}
    set search_vector = to_tsvector('simple', unaccent(coalesce(item, '')))
    where recipe_id = ${recipeId}
  `);
}

/**
 * Tokenise a free-text user query into a Postgres `tsquery` string.
 * Each token gets `:*` (prefix match) and tokens are AND-ed together.
 * Returns null for an effectively empty query.
 */
export function buildTsQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}:*`).join(" & ");
}
