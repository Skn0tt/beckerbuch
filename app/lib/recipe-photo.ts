import { PHOTO_MAX_BYTES, validatePhotoBytes } from "../blobs";

/**
 * Decode a photo attached to an MCP `kochbuch_add_recipe` call.
 *
 * Clients such as ChatGPT skip optional image fields, and
 * `fetch_recipe` used to hand back a cover the add tool could not
 * store. The add tool requires `photoSource` `bytes` or `url`; this
 * validates the bytes path.
 */

export type PhotoBytesResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; error: string };

const DATA_URL = /^data:([^;,]+);base64,([\s\S]+)$/i;

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
