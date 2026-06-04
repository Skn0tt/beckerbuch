import { getBlobStore } from "./lib/storage";

const STORE_NAME = "recipes";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type StoredPhoto = {
  key: string;
  contentType: string;
};

export type PhotoValidationError = string;

export const PHOTO_MAX_BYTES = MAX_PHOTO_BYTES;

function recipeStore() {
  return getBlobStore(STORE_NAME);
}

export type PhotoValidationResult =
  | { ok: true; contentType: string }
  | { ok: false; error: PhotoValidationError };

/**
 * Validate raw photo bytes. Used by both the upload-File path
 * (browser form) and the MCP photoUrl-fetch path.
 */
export function validatePhotoBytes(
  size: number,
  contentType: string,
): PhotoValidationResult {
  if (size === 0) return { ok: false, error: "Photo file is empty." };
  if (size > MAX_PHOTO_BYTES) {
    return {
      ok: false,
      error: `Photo is too large (max ${MAX_PHOTO_BYTES / 1024 / 1024} MB).`,
    };
  }
  const type = contentType.toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    return { ok: false, error: "Photo must be a JPEG, PNG, or WebP image." };
  }
  return { ok: true, contentType: type };
}

/**
 * Validate an uploaded photo File. Returns the normalised content-type
 * if OK, or a string error message.
 */
export function validatePhoto(file: File): PhotoValidationResult {
  return validatePhotoBytes(file.size, file.type);
}

export async function storePhoto(
  recipeId: string,
  file: File,
  contentType: string,
): Promise<string> {
  const buf = await file.arrayBuffer();
  return storePhotoBytes(recipeId, buf, contentType);
}

export async function storePhotoBytes(
  recipeId: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<string> {
  const ext = MIME_TO_EXT[contentType] ?? "bin";
  const random = crypto.randomUUID();
  const key = `recipes/${recipeId}/${random}.${ext}`;
  // Normalise Uint8Array to a fresh ArrayBuffer for the storage driver.
  let payload: ArrayBuffer;
  if (bytes instanceof Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    payload = copy.buffer;
  } else {
    payload = bytes;
  }
  const store = await recipeStore();
  return store.put(key, payload, contentType);
}

export async function deletePhoto(key: string): Promise<void> {
  const store = await recipeStore();
  await store.del(key);
}

export async function readPhoto(
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const store = await recipeStore();
  return store.get(key);
}
