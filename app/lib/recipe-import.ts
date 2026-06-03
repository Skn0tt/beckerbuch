import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse as parseHtml } from "node-html-parser";
import { validatePhotoBytes } from "../blobs";
import { fetchWithTimeout } from "./http";
import { importKptncookRecipe, parseKptncookId } from "./kptncook";

/**
 * Generic recipe importer. Fetches an arbitrary web page and extracts a
 * recipe from its schema.org JSON-LD metadata (the format used by the
 * overwhelming majority of recipe sites). The result is shaped exactly
 * like the kptncook importer so the form / MCP tool can consume either.
 *
 * `importRecipe` is the unified entry point: it dispatches kptncook
 * share URLs / uids / oids to the kptncook importer and everything else
 * to the JSON-LD importer.
 */

const FETCH_TIMEOUT_MS = 10_000;
const HTML_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const KPTNCOOK_HOSTS = new Set(["share.kptncook.com", "mobile.kptncook.com"]);

export type RecipeImportIngredient = {
  amount: string | null;
  unit: string | null;
  item: string;
};

export type RecipeImport = {
  name: string;
  baseQuantity: number;
  sourceUrl: string | null;
  sourceHost: string | null;
  steps: string;
  ingredients: RecipeImportIngredient[];
  photo?: { bytes: Uint8Array; contentType: string };
};

export type RecipeImportResult =
  | { ok: true; recipe: RecipeImport }
  | { ok: false; error: string };

// --------------------------------------------------------------------
// SSRF guard

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return parts;
}

/** True for loopback / private / link-local / reserved IPv4 ranges. */
function isPrivateIPv4(ip: string): boolean {
  const p = ipv4ToParts(ip);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** True for loopback / unique-local / link-local IPv6 ranges. */
function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase().split("%")[0];
  if (s === "::1" || s === "::") return true;
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  const head = s.split(":")[0];
  const first = parseInt(head || "0", 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Reject URLs that could reach internal infrastructure (SSRF). Enforces
 * http(s), then resolves the host via DNS and rejects private / loopback
 * / link-local / reserved IPs. Re-checking the resolved IP mitigates
 * (but does not fully eliminate) DNS-rebinding.
 */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportError("That doesn't look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImportError("Only http(s) URLs are supported.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new ImportError("Refusing to fetch a local address.");
  }

  // If the host is already an IP literal, check it directly.
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new ImportError("Refusing to fetch a private address.");
    return url;
  }

  let resolved: { address: string }[];
  try {
    resolved = await dnsLookup(host, { all: true });
  } catch {
    throw new ImportError("Could not resolve that host.");
  }
  if (resolved.length === 0) throw new ImportError("Could not resolve that host.");
  for (const { address } of resolved) {
    if (isBlockedIp(address)) {
      throw new ImportError("Refusing to fetch a private address.");
    }
  }
  return url;
}

class ImportError extends Error {}

// --------------------------------------------------------------------
// JSON-LD extraction

type JsonLdNode = Record<string, unknown>;

function typeIncludes(node: JsonLdNode, type: string): boolean {
  const t = node["@type"];
  if (typeof t === "string") return t.toLowerCase() === type.toLowerCase();
  if (Array.isArray(t)) {
    return t.some((x) => typeof x === "string" && x.toLowerCase() === type.toLowerCase());
  }
  return false;
}

/** Walk arbitrary JSON-LD (arrays, @graph) collecting plain object nodes. */
function* iterNodes(value: unknown): Generator<JsonLdNode> {
  if (Array.isArray(value)) {
    for (const v of value) yield* iterNodes(v);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as JsonLdNode;
  yield node;
  if (Array.isArray(node["@graph"])) {
    for (const v of node["@graph"] as unknown[]) yield* iterNodes(v);
  }
}

/**
 * Find the schema.org Recipe node in a page's JSON-LD. Pages often embed
 * several Recipe nodes (related/recommended recipes), so when a page URL
 * is given we prefer the node whose own url / mainEntityOfPage matches
 * it, falling back to the first Recipe found.
 */
export function findRecipeNode(html: string, pageUrl?: string): JsonLdNode | null {
  const root = parseHtml(html);
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  const recipes: JsonLdNode[] = [];
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent.trim());
    } catch {
      continue;
    }
    for (const node of iterNodes(parsed)) {
      if (typeIncludes(node, "Recipe")) recipes.push(node);
    }
  }
  if (recipes.length === 0) return null;
  if (recipes.length === 1 || !pageUrl) return recipes[0];

  let pagePath: string | null = null;
  try {
    pagePath = new URL(pageUrl).pathname.replace(/\/$/, "");
  } catch {
    pagePath = null;
  }
  if (pagePath) {
    for (const node of recipes) {
      const candidate =
        firstString(node.url) ??
        firstString(node.mainEntityOfPage) ??
        firstString((node.mainEntityOfPage as JsonLdNode | undefined)?.["@id"]);
      if (!candidate) continue;
      try {
        if (new URL(candidate).pathname.replace(/\/$/, "") === pagePath) return node;
      } catch {
        // ignore unparseable candidate URLs
      }
    }
  }
  return recipes[0];
}

// --------------------------------------------------------------------
// Mapping helpers

function firstString(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t || null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const got = firstString(v);
      if (got) return got;
    }
  }
  return null;
}

const UNIT_WORDS = new Set([
  "g", "gram", "grams", "kg", "kilogram", "kilograms",
  "mg", "ml", "milliliter", "milliliters", "millilitre", "millilitres",
  "l", "liter", "liters", "litre", "litres", "cl", "dl",
  "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds",
  "tsp", "teaspoon", "teaspoons", "tbsp", "tablespoon", "tablespoons",
  "cup", "cups", "pint", "pints", "quart", "quarts", "gallon", "gallons",
  "pinch", "pinches", "dash", "clove", "cloves", "can", "cans", "jar", "jars",
  "package", "packages", "pkg", "stick", "sticks", "slice", "slices",
  "el", "tl", "prise", "prisen", "stück", "stk", "bund", "dose", "dosen",
  "packung", "packungen", "scheibe", "scheiben", "tasse", "tassen",
]);

const FRACTION_MAP: Record<string, string> = {
  "½": "0.5", "⅓": "0.333", "⅔": "0.667", "¼": "0.25", "¾": "0.75",
  "⅕": "0.2", "⅖": "0.4", "⅗": "0.6", "⅘": "0.8",
  "⅙": "0.167", "⅚": "0.833", "⅛": "0.125", "⅜": "0.375",
  "⅝": "0.625", "⅞": "0.875",
};

const FRACTION_GLYPHS = Object.keys(FRACTION_MAP).join("");

function roundQty(n: number): string {
  // Up to 3 decimals, trailing zeros trimmed.
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Replace unicode fraction glyphs with decimals, folding mixed numbers
 * ("1½" → "1.5", "8¾" → "8.75") and bare fractions ("½" → "0.5") into a
 * single decimal token.
 */
function normalizeFractions(text: string): string {
  let out = text;
  // Mixed number: a digit directly (optionally space) before a glyph.
  const mixed = new RegExp(`(\\d+)\\s*([${FRACTION_GLYPHS}])`, "g");
  out = out.replace(mixed, (_m, whole: string, glyph: string) => {
    const frac = Number(FRACTION_MAP[glyph] ?? "0");
    return roundQty(Number(whole) + frac);
  });
  // Remaining standalone glyphs.
  for (const [glyph, val] of Object.entries(FRACTION_MAP)) {
    out = out.replaceAll(glyph, ` ${val}`);
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Parse a free-text ingredient line (e.g. "250 g flour", "1 ½ cups sugar",
 * "2 cloves garlic, minced", "salt to taste") into amount / unit / item.
 * Conservative: when no leading number is found, the whole string becomes
 * the item with null amount/unit.
 */
export function parseIngredientString(raw: string): RecipeImportIngredient | null {
  const original = raw.replace(/\s+/g, " ").trim();
  if (!original) return null;

  const text = normalizeFractions(original);
  // Leading quantity: a number or a range ("2-3"), optionally a second
  // number to fold a leftover mixed number ("1 0.5" → 1.5).
  const qtyMatch = text.match(
    /^(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?(?:\s+(\d+(?:[.,]\d+)?))?\s+(.*)$/,
  );
  if (!qtyMatch) {
    return { amount: null, unit: null, item: original };
  }

  const [, first, rangeEnd, mixedFrac, restRaw] = qtyMatch;
  let amount: string;
  if (rangeEnd) {
    amount = `${first.replace(",", ".")}-${rangeEnd.replace(",", ".")}`;
  } else if (mixedFrac) {
    amount = roundQty(Number(first.replace(",", ".")) + Number(mixedFrac.replace(",", ".")));
  } else {
    amount = first.replace(",", ".");
  }

  const rest = restRaw.trim();
  const restWords = rest.split(" ");
  let unit: string | null = null;
  let item = rest;
  if (restWords.length >= 2) {
    const candidate = restWords[0].toLowerCase().replace(/\.$/, "");
    if (UNIT_WORDS.has(candidate)) {
      unit = restWords[0].replace(/\.$/, "");
      item = restWords.slice(1).join(" ").trim();
    }
  }

  if (!item) item = rest;
  return { amount: amount || null, unit, item };
}

function mapIngredients(value: unknown): RecipeImportIngredient[] {
  const list = Array.isArray(value) ? value : value != null ? [value] : [];
  const out: RecipeImportIngredient[] = [];
  for (const entry of list) {
    const str = firstString(entry);
    if (!str) continue;
    const parsed = parseIngredientString(str);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Flatten schema.org recipeInstructions (string | HowToStep[] | HowToSection[]). */
function mapSteps(value: unknown): string {
  const steps: string[] = [];

  const pushText = (t: string | null) => {
    if (t) {
      // Some sites put the whole thing as one HTML blob; strip tags lightly.
      const clean = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (clean) steps.push(clean);
    }
  };

  const walk = (v: unknown) => {
    if (typeof v === "string") {
      // A single string may contain newlines separating steps.
      for (const line of v.split(/\r?\n+/)) pushText(line.trim());
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      const node = v as JsonLdNode;
      if (typeIncludes(node, "HowToSection")) {
        walk(node.itemListElement ?? node.steps);
        return;
      }
      // HowToStep or plain object with text/name.
      pushText(firstString(node.text) ?? firstString(node.name));
    }
  };

  walk(value);
  return steps.join("\n\n");
}

function parseYield(value: unknown): number {
  const str = firstString(Array.isArray(value) ? value : value);
  if (!str) return 2;
  const m = str.match(/\d+/);
  if (!m) return 2;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(Math.max(Math.round(n), 1), 1000);
}

function imageUrl(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const got = imageUrl(v);
      if (got) return got;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as JsonLdNode;
    return firstString(obj.url) ?? firstString(obj.contentUrl);
  }
  return null;
}

/**
 * Map a schema.org Recipe JSON-LD node to our import shape. Returns null
 * unless there's a name and at least one ingredient.
 */
export function mapSchemaOrgRecipe(node: JsonLdNode, pageUrl: string): RecipeImport | null {
  const name = firstString(node.name) ?? firstString(node.headline);
  if (!name) return null;

  const ingredients = mapIngredients(node.recipeIngredient ?? node.ingredients);
  if (ingredients.length === 0) return null;

  const steps = mapSteps(node.recipeInstructions);
  const baseQuantity = parseYield(node.recipeYield ?? node.yield);

  let sourceUrl: string | null = pageUrl;
  let sourceHost: string | null = null;
  const explicitUrl = firstString(node.url) ?? firstString(node.mainEntityOfPage);
  if (explicitUrl && /^https?:\/\//i.test(explicitUrl)) sourceUrl = explicitUrl;
  try {
    sourceHost = new URL(sourceUrl).host;
  } catch {
    sourceHost = null;
  }

  return { name, baseQuantity, sourceUrl, sourceHost, steps, ingredients };
}

// --------------------------------------------------------------------
// Photo fetch

async function fetchPhoto(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  let publicUrl: URL;
  try {
    publicUrl = await assertPublicUrl(url);
  } catch {
    return null;
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(
      publicUrl.toString(),
      { redirect: "follow", headers: { "User-Agent": USER_AGENT } },
      FETCH_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const declaredLen = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > PHOTO_MAX_BYTES) return null;

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim();
  const buf = await response.arrayBuffer();
  if (buf.byteLength > PHOTO_MAX_BYTES) return null;
  const bytes = new Uint8Array(buf);

  const ct = contentType && contentType !== "application/octet-stream" ? contentType : "image/jpeg";
  const v = validatePhotoBytes(bytes.byteLength, ct);
  if (!v.ok) return null;
  return { bytes, contentType: v.contentType };
}

// --------------------------------------------------------------------
// Entry points

/**
 * Fetch an arbitrary recipe page and extract a recipe from its
 * schema.org JSON-LD. Photo fetch is best-effort.
 */
export async function importRecipeFromUrl(
  input: string,
  opts: { includePhoto?: boolean } = {},
): Promise<RecipeImportResult> {
  const includePhoto = opts.includePhoto !== false;

  let url: URL;
  try {
    url = await assertPublicUrl(input.trim());
  } catch (err) {
    return { ok: false, error: err instanceof ImportError ? err.message : "Invalid URL." };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url.toString(),
      {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      },
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return { ok: false, error: `Could not fetch that page: ${msg}` };
  }

  if (!response.ok) {
    return { ok: false, error: `That page returned HTTP ${response.status}.` };
  }

  const declaredLen = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > HTML_MAX_BYTES) {
    return { ok: false, error: "That page is too large to import." };
  }

  const html = await response.text();
  if (html.length > HTML_MAX_BYTES * 2) {
    return { ok: false, error: "That page is too large to import." };
  }

  // Use the post-redirect URL as the canonical page URL.
  const finalUrl = response.url || url.toString();
  const node = findRecipeNode(html, finalUrl);
  if (!node) {
    return {
      ok: false,
      error: "Couldn't find a recipe on that page (no schema.org recipe data).",
    };
  }

  const recipe = mapSchemaOrgRecipe(node, finalUrl);
  if (!recipe) {
    return {
      ok: false,
      error: "That page's recipe data was missing the fields we need (name + ingredients).",
    };
  }

  if (includePhoto) {
    const photoSrc = imageUrl(node.image);
    if (photoSrc) {
      const resolved = (() => {
        try {
          return new URL(photoSrc, url).toString();
        } catch {
          return photoSrc;
        }
      })();
      const photo = await fetchPhoto(resolved);
      if (photo) recipe.photo = photo;
    }
  }

  return { ok: true, recipe };
}

/**
 * Unified import entry point. Dispatches kptncook share URLs / uids /
 * oids to the kptncook importer and everything else (any http(s) recipe
 * page URL) to the JSON-LD importer.
 */
export async function importRecipe(
  input: string,
  opts: { includePhoto?: boolean } = {},
): Promise<RecipeImportResult> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Please provide a recipe URL or kptncook share link / id." };
  }

  // URL? Route kptncook hosts to the kptncook importer, others to JSON-LD.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const host = new URL(trimmed).hostname.toLowerCase();
      if (KPTNCOOK_HOSTS.has(host)) {
        return importKptncookRecipe(trimmed, opts);
      }
    } catch {
      // fall through
    }
    return importRecipeFromUrl(trimmed, opts);
  }

  // Not a URL: a bare kptncook uid/oid is the only non-URL we accept.
  if (parseKptncookId(trimmed)) {
    return importKptncookRecipe(trimmed, opts);
  }

  return {
    ok: false,
    error: "Enter a recipe page URL, or a kptncook share link / id.",
  };
}
