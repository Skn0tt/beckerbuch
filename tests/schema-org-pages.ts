// Canned schema.org pages for the recipe-import specs. The HTML is
// synthetic (not a snapshot of a third-party site). Importing this
// module checks that the existing parser accepts each page, so a
// fixture that would not survive `importRecipeFromUrl` fails before
// the suite spends a browser on it.

import { readFileSync } from "node:fs";

import { validatePhotoBytes } from "../app/blobs";
import { findRecipeNode, mapSchemaOrgRecipe } from "../app/lib/recipe-import";

function readFixture(name: string): string {
  return readFileSync(
    new URL(`./schema-org-fixtures/${name}`, import.meta.url),
    "utf8",
  );
}

/** 1×1 JPEG served for every canned cover photo. */
export const CANNED_COVER_JPEG = readFileSync(
  new URL("./schema-org-fixtures/cover.jpg", import.meta.url),
);

const coverPhoto = validatePhotoBytes(
  CANNED_COVER_JPEG.byteLength,
  "image/jpeg",
);
if (!coverPhoto.ok) {
  throw new Error(`canned cover.jpg is not a valid photo: ${coverPhoto.error}`);
}

export type CannedRecipeFixture = {
  label: string;
  pageUrl: string;
  imageUrl: string;
  html: string;
  nameRe: RegExp;
  hostRe: RegExp;
  minIngredients: number;
  /** Present only in the canned steps, so a real-site fallthrough fails. */
  stepMarker: string;
};

export const BON_APPETIT_COOKIES: CannedRecipeFixture = {
  label: "Bon Appétit chocolate chip cookies",
  pageUrl: "https://www.bonappetit.com/recipe/bas-best-chocolate-chip-cookies",
  imageUrl:
    "https://www.bonappetit.com/images/bas-best-chocolate-chip-cookies.jpg",
  html: readFixture("bon-appetit-chocolate-chip-cookies.html"),
  nameRe: /cookie/i,
  hostRe: /bonappetit\.com$/,
  minIngredients: 5,
  stepMarker: "canned-fixture-bon-appetit",
};

export const LOVE_AND_LEMONS_BANANA_BREAD: CannedRecipeFixture = {
  label: "Love and Lemons banana bread",
  pageUrl: "https://www.loveandlemons.com/banana-bread/",
  imageUrl: "https://www.loveandlemons.com/images/banana-bread.jpg",
  html: readFixture("love-and-lemons-banana-bread.html"),
  nameRe: /banana bread/i,
  hostRe: /loveandlemons\.com$/,
  minIngredients: 6,
  stepMarker: "canned-fixture-love-and-lemons",
};

export const CANNED_RECIPE_PAGES: CannedRecipeFixture[] = [
  BON_APPETIT_COOKIES,
  LOVE_AND_LEMONS_BANANA_BREAD,
];

export const BBC_BAKED_RATATOUILLE: CannedRecipeFixture = {
  label: "BBC Good Food baked ratatouille",
  pageUrl: "https://www.bbcgoodfood.com/recipes/baked-ratatouille-goats-cheese",
  imageUrl:
    "https://www.bbcgoodfood.com/images/baked-ratatouille-goats-cheese.jpg",
  html: readFixture("bbc-baked-ratatouille.html"),
  nameRe: /ratatouille/i,
  hostRe: /bbcgoodfood\.com$/,
  minIngredients: 15,
  stepMarker: "canned-fixture-bbc",
};

/** Non-recipe page used by the "no recipe data" error case. */
export const CANNED_NO_RECIPE_URL = "https://example.com/";
export const CANNED_NO_RECIPE_HTML = readFixture("example-no-recipe.html");

/**
 * Hosts the recipe-import specs are allowed to fetch. Register
 * {@link cannedRecipePagesHandler} on this pattern; anything else on
 * these hosts is 404'd inside the handler.
 */
export const CANNED_SCHEMA_ORG_HOSTS =
  /^https:\/\/(?:www\.bonappetit\.com|www\.loveandlemons\.com|www\.bbcgoodfood\.com|example\.com)(?:[/?#]|$)/;

type ParsedIngredient = {
  amount: string | null;
  unit: string | null;
  item: string;
};

// Exact rows the BBC Good Food UI snapshot asserts. The curly
// apostrophe in "goat’s" is U+2019, matching the aria snapshot.
const BBC_INGREDIENTS: ParsedIngredient[] = [
  { amount: "4", unit: "tbsp", item: "olive oil" },
  { amount: "2", unit: null, item: "red onions chopped" },
  { amount: "2", unit: null, item: "garlic cloves finely chopped" },
  { amount: "2", unit: null, item: "aubergines diced" },
  { amount: "2", unit: null, item: "red peppers seeded and diced" },
  { amount: "1", unit: "tsp", item: "smoked paprika" },
  { amount: "2", unit: "tbsp", item: "balsamic vinegar" },
  { amount: "1", unit: "tsp", item: "soy sauce" },
  { amount: "500", unit: "ml", item: "passata" },
  { amount: "200", unit: "g", item: "young goat\u2019s cheese" },
  {
    amount: "4",
    unit: null,
    item: "courgettes (a mixture of green and yellow looks nice), thinly sliced",
  },
  { amount: "400", unit: "ml", item: "milk" },
  { amount: "50", unit: "g", item: "unsalted butter" },
  { amount: "50", unit: "g", item: "plain flour" },
  {
    amount: "80",
    unit: "g",
    item: "parmesan or vegetarian alternative, finely grated",
  },
];

function assertParses(
  page: CannedRecipeFixture,
  expected?: ParsedIngredient[],
) {
  if (!page.html.includes(page.pageUrl) || !page.html.includes(page.imageUrl)) {
    throw new Error(
      `${page.label}: HTML does not reference its page or image URL`,
    );
  }
  const node = findRecipeNode(page.html, page.pageUrl);
  if (!node) throw new Error(`${page.label}: findRecipeNode returned null`);
  const mapped = mapSchemaOrgRecipe(node, page.pageUrl);
  if (!mapped)
    throw new Error(`${page.label}: mapSchemaOrgRecipe returned null`);
  if (!page.nameRe.test(mapped.name)) {
    throw new Error(
      `${page.label}: name ${JSON.stringify(mapped.name)} failed ${page.nameRe}`,
    );
  }
  const host = mapped.sourceUrl ? new URL(mapped.sourceUrl).host : "";
  if (!page.hostRe.test(host)) {
    throw new Error(`${page.label}: source host ${host} failed ${page.hostRe}`);
  }
  if (mapped.ingredients.length < page.minIngredients) {
    throw new Error(
      `${page.label}: expected >= ${page.minIngredients} ingredients, got ${mapped.ingredients.length}`,
    );
  }
  if (!mapped.ingredients.some((ingredient) => ingredient.amount !== null)) {
    throw new Error(`${page.label}: no ingredient parsed an amount`);
  }
  if (!mapped.steps.includes(page.stepMarker)) {
    throw new Error(`${page.label}: steps missing ${page.stepMarker}`);
  }
  if (node.image !== page.imageUrl) {
    throw new Error(
      `${page.label}: image ${JSON.stringify(node.image)} !== ${page.imageUrl}`,
    );
  }
  if (!expected) return;
  const actual = mapped.ingredients.map(({ amount, unit, item }) => ({
    amount,
    unit,
    item,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${page.label}: ingredient mismatch\n${JSON.stringify(actual, null, 2)}`,
    );
  }
  if (mapped.steps.split("\n\n").length !== 4) {
    throw new Error(
      `${page.label}: expected 4 steps, got ${JSON.stringify(mapped.steps)}`,
    );
  }
}

for (const page of CANNED_RECIPE_PAGES) assertParses(page);
assertParses(BBC_BAKED_RATATOUILLE, BBC_INGREDIENTS);

if (findRecipeNode(CANNED_NO_RECIPE_HTML, CANNED_NO_RECIPE_URL)) {
  throw new Error("example.com fixture unexpectedly contains a Recipe node");
}
