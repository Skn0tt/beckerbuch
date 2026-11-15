import { PHOTO_MAX_BYTES, validatePhotoBytes } from "../blobs";
import { fetchWithTimeout } from "./http";

/**
 * Photos for recipes created over MCP.
 *
 * Clients such as ChatGPT skip optional image fields, and
 * `fetch_recipe` used to hand back a cover the add tool could not
 * store. `kochbuch_add_recipe` now requires `photoSource`: the real
 * cover (`bytes` / `url`) or `generate`, which draws a dish photo
 * here so a saved recipe still has one.
 */

export type PhotoBytesResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; error: string };

const DATA_URL = /^data:([^;,]+);base64,([\s\S]+)$/i;
const DEFAULT_MODEL = "gemini-2.5-flash-image";
// Netlify Server must send status and headers within 20s. Leave the
// rest of add_recipe (insert + blob write) a little room.
const GENERATE_TIMEOUT_MS = 15_000;

function normalizeImageMime(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  return type;
}

export function photoFromBase64(
  raw: string,
  contentType: string,
): PhotoBytesResult {
  const dataUrl = DATA_URL.exec(raw.trim());
  const payload = (dataUrl ? dataUrl[2] : raw).replace(/\s/g, "");
  const mime = normalizeImageMime(dataUrl?.[1] || contentType);
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    return { ok: false, error: "Photo base64 is not valid base64." };
  }
  const decodedLen =
    Math.floor((payload.length * 3) / 4) -
    (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  if (decodedLen > PHOTO_MAX_BYTES) {
    return {
      ok: false,
      error: `Photo is too large (max ${PHOTO_MAX_BYTES / 1024 / 1024} MB).`,
    };
  }
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  const validated = validatePhotoBytes(bytes.byteLength, mime);
  if (!validated.ok) return { ok: false, error: validated.error };
  return { ok: true, bytes, contentType: validated.contentType };
}

export function recipePhotoPrompt(name: string, items: string[]): string {
  const title = name.trim().replace(/\s+/g, " ").slice(0, 200);
  const visible = items
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, 8);
  const ingredients = visible.length ? ` Show ${visible.join(", ")}.` : "";
  return `Photorealistic photo of ${title}, the finished dish on a plate, natural daylight, no text, no logo, no people.${ingredients}`;
}

type GeminiImageResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
  }>;
};

export async function generateRecipePhoto(input: {
  name: string;
  items: string[];
}): Promise<PhotoBytesResult> {
  const apiKey =
    process.env.RECIPE_PHOTO_GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.EMBEDDING_GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error:
        'Could not generate a recipe photo: GEMINI_API_KEY is not configured. Pass photoSource "bytes" or "url" instead.',
    };
  }

  const model = process.env.RECIPE_PHOTO_MODEL ?? DEFAULT_MODEL;
  const baseURL =
    process.env.RECIPE_PHOTO_GEMINI_BASE_URL ??
    process.env.EMBEDDING_GEMINI_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta";
  const url = `${baseURL}/models/${model}:generateContent`;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: recipePhotoPrompt(input.name, input.items) }],
            },
          ],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: "1:1" },
          },
        }),
      },
      GENERATE_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return { ok: false, error: `Could not generate a recipe photo: ${msg}.` };
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    return {
      ok: false,
      error:
        `Could not generate a recipe photo: HTTP ${response.status} ${detail}.`.trim(),
    };
  }

  let json: GeminiImageResponse;
  try {
    json = (await response.json()) as GeminiImageResponse;
  } catch {
    return {
      ok: false,
      error: "Could not generate a recipe photo: response was not JSON.",
    };
  }

  const part = json.candidates?.[0]?.content?.parts?.find(
    (candidate) => candidate.inlineData?.data,
  );
  const data = part?.inlineData?.data;
  if (!data) {
    return {
      ok: false,
      error: "Could not generate a recipe photo: the model returned no image.",
    };
  }
  const mime = part?.inlineData?.mimeType || "image/png";
  const decoded = photoFromBase64(data, mime);
  if (!decoded.ok) {
    return {
      ok: false,
      error: `Could not generate a recipe photo: ${decoded.error}`,
    };
  }
  return decoded;
}
