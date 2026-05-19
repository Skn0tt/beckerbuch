import { validatePhotoBytes } from "../blobs";

/**
 * kptncook integration. Imports a single recipe via share URL, uid,
 * or oid, returning a payload shaped for our recipe form / MCP tool.
 *
 * Only one upstream endpoint is involved: the misleadingly named
 * `POST /recipes/search?kptnkey=<API_KEY>`, which is actually a
 * batch resolve-ids endpoint. We always pass exactly one id and
 * read the first element of the response.
 *
 * No access token (login) is required for this flow; only the
 * static mobile-app API key (`KPTNCOOK_API_KEY`). Reference:
 * https://github.com/ephes/kptncook (src/kptncook/api.py).
 */

const SHARE_HOST = "share.kptncook.com";
const BASE_URL = "https://mobile.kptncook.com";
const FETCH_TIMEOUT_MS = 10_000;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const KPTN_HEADERS = {
  "content-type": "application/json",
  Accept: "application/vnd.kptncook.mobile-v8+json",
  "User-Agent": "Platform/Android/12.0.1 App/7.10.1",
  hasIngredients: "yes",
};

function getApiKey(): string | null {
  const key = process.env.KPTNCOOK_API_KEY;
  return key && key.length > 0 ? key : null;
}

export type KptncookId = { type: "oid" | "uid"; value: string };

/**
 * Port of `parse_id` from kptncook/api.py. Tries uid (7-8 alnum)
 * first, then oid (24-char hex). Splits on URL/query/whitespace
 * separators so a full canonical URL works.
 */
export function parseKptncookId(text: string): KptncookId | null {
  const looksLikeUid = (s: string) =>
    (s.length === 7 || s.length === 8) && /^[A-Za-z0-9]+$/.test(s);
  const looksLikeOid = (s: string) =>
    s.length === 24 && /^[a-fA-F0-9]+$/.test(s);

  for (const part of text.split(/[/?]/)) {
    if (looksLikeUid(part)) return { type: "uid", value: part };
  }
  for (const part of text.split(/[ ,/]/)) {
    if (looksLikeOid(part)) return { type: "oid", value: part };
  }
  return null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow exactly one redirect from a share.kptncook.com URL to
 * extract the canonical recipe URL (which embeds the uid/oid).
 */
async function resolveShareUrl(shareUrl: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(shareUrl, { redirect: "manual" });
    if (res.status !== 301 && res.status !== 302) return null;
    return res.headers.get("location");
  } catch {
    return null;
  }
}

export type KptncookIngredient = {
  amount: string | null;
  unit: string | null;
  item: string;
};

export type KptncookImport = {
  name: string;
  baseQuantity: number;
  sourceUrl: string | null;
  sourceHost: string | null;
  steps: string;
  ingredients: KptncookIngredient[];
  photo?: { bytes: Uint8Array; contentType: string };
};

export type KptncookImportResult =
  | { ok: true; recipe: KptncookImport }
  | { ok: false; error: string };

const LANG_FALLBACK = ["de", "en", "es", "fr", "pt"] as const;

function localizedString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  // Nested shapes used for ingredient titles: { singular: {...}, plural: {...} }
  for (const key of ["singular", "plural", "uncountable"] as const) {
    if (key in obj) {
      const inner = localizedString(obj[key]);
      if (inner) return inner;
    }
  }

  for (const lang of LANG_FALLBACK) {
    const candidate = obj[lang];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function ingredientTitle(ingredient: Record<string, unknown>): string | null {
  for (const key of ["localizedTitle", "uncountableTitle", "numberTitle", "title", "name"]) {
    const got = localizedString(ingredient[key]);
    if (got) return got;
  }
  return null;
}

function unitLabel(measure: unknown): string | null {
  if (typeof measure === "string") return measure.trim() || null;
  if (!measure || typeof measure !== "object") return null;
  const obj = measure as Record<string, unknown>;
  for (const key of ["localizedTitle", "shortTitle", "name"]) {
    const got = localizedString(obj[key]);
    if (got) return got;
  }
  return null;
}

function formatAmount(quantity: unknown): string | null {
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) return null;
  if (quantity === 0) return null;
  // Drop trailing zeros for cleanliness (e.g. 1 instead of 1.0).
  return Number.isInteger(quantity) ? String(quantity) : String(quantity);
}

/**
 * Map a raw kptncook recipe payload to our import shape.
 * Lossy by design: we keep only what we render in the recipe form.
 */
export function mapKptncookRecipe(raw: unknown): KptncookImport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const name = localizedString(r.localizedTitle) ?? localizedString(r.title) ?? localizedString(r.name);
  if (!name) return null;

  const rawIngredients = Array.isArray(r.ingredients) ? r.ingredients : [];
  const ingredients: KptncookIngredient[] = [];
  for (const entry of rawIngredients) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const ingredientObj =
      e.ingredient && typeof e.ingredient === "object"
        ? (e.ingredient as Record<string, unknown>)
        : null;
    const item = ingredientObj ? ingredientTitle(ingredientObj) : null;
    if (!item) continue;
    ingredients.push({
      amount: formatAmount(e.quantity),
      unit: unitLabel(e.measure),
      item,
    });
  }
  if (ingredients.length === 0) return null;

  const stepTexts: string[] = [];
  const rawSteps = Array.isArray(r.steps) ? r.steps : [];
  for (const step of rawSteps) {
    if (!step || typeof step !== "object") continue;
    const title = localizedString((step as Record<string, unknown>).title);
    if (title) stepTexts.push(title);
  }
  const steps = stepTexts.length > 0 ? stepTexts.join("\n\n") : "";

  // baseQuantity: kptncook quantities are per portion; default to 2
  // (matches their app's default serving size). User can adjust in the
  // pre-filled form before saving.
  const baseQuantity = 2;

  let sourceUrl: string | null = null;
  let sourceHost: string | null = null;
  if (typeof r.uid === "string" && r.uid.length > 0) {
    sourceUrl = `https://share.kptncook.com/${r.uid}`;
    try {
      sourceHost = new URL(sourceUrl).host;
    } catch {
      sourceHost = null;
    }
  }

  return {
    name,
    baseQuantity,
    sourceUrl,
    sourceHost,
    steps,
    ingredients,
  };
}

function coverImageUrl(raw: unknown, apiKey: string): string | null {
  if (!raw || typeof raw !== "object") return null;
  const list = (raw as Record<string, unknown>).imageList;
  if (!Array.isArray(list)) return null;
  // Prefer cover; fall back to the first image with a URL.
  const candidates = list.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).url === "string",
  );
  const cover = candidates.find((entry) => entry.type === "cover") ?? candidates[0];
  if (!cover) return null;
  const url = cover.url as string;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}kptnkey=${encodeURIComponent(apiKey)}`;
}

async function fetchKptncookPhoto(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { redirect: "follow" });
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

  // kptncook serves jpeg without a clean content-type sometimes; default
  // to image/jpeg when the header is missing / generic, then validate.
  const ct = contentType && contentType !== "application/octet-stream" ? contentType : "image/jpeg";
  const v = validatePhotoBytes(bytes.byteLength, ct);
  if (!v.ok) return null;
  return { bytes, contentType: v.contentType };
}

/**
 * Resolve a share URL / uid / oid into a normalized recipe payload.
 * Photo fetch is best-effort: failures are silently dropped, but a
 * kptncook API error or "not found" surfaces as `{ok:false}`.
 */
export async function importKptncookRecipe(
  input: string,
  opts: { includePhoto?: boolean } = {},
): Promise<KptncookImportResult> {
  const includePhoto = opts.includePhoto !== false;

  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error: "kptncook import is not configured (KPTNCOOK_API_KEY missing).",
    };
  }

  let target = input.trim();
  if (!target) return { ok: false, error: "Please provide a kptncook share URL or id." };

  if (/^https?:\/\//i.test(target)) {
    try {
      const parsed = new URL(target);
      if (parsed.host === SHARE_HOST) {
        const next = await resolveShareUrl(target);
        if (!next) {
          return {
            ok: false,
            error: "Could not resolve kptncook share URL (no redirect).",
          };
        }
        target = next;
      }
    } catch {
      // Not a URL we can parse; fall through to id parsing.
    }
  }

  const parsed = parseKptncookId(target);
  if (!parsed) {
    return {
      ok: false,
      error: "Could not find a kptncook id (uid/oid) in the input.",
    };
  }

  const body =
    parsed.type === "oid"
      ? [{ identifier: parsed.value }]
      : [{ uid: parsed.value }];

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${BASE_URL}/recipes/search?kptnkey=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: KPTN_HEADERS,
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return { ok: false, error: `kptncook request failed: ${msg}` };
  }

  if (!response.ok) {
    return { ok: false, error: `kptncook returned HTTP ${response.status}.` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "kptncook response was not valid JSON." };
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    return { ok: false, error: "kptncook returned no recipe for that id." };
  }

  const raw = payload[0];
  const recipe = mapKptncookRecipe(raw);
  if (!recipe) {
    return {
      ok: false,
      error: "kptncook payload was missing the fields we need (name + ingredients).",
    };
  }

  if (includePhoto) {
    const photoUrl = coverImageUrl(raw, apiKey);
    if (photoUrl) {
      const photo = await fetchKptncookPhoto(photoUrl);
      if (photo) recipe.photo = photo;
    }
  }

  return { ok: true, recipe };
}
