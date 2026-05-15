import { getStore } from "@netlify/blobs";

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

function recipeStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

/**
 * Validate an uploaded photo File. Returns the normalised content-type
 * if OK, or a string error message.
 */
export function validatePhoto(file: File): { ok: true; contentType: string } | { ok: false; error: PhotoValidationError } {
  if (file.size === 0) return { ok: false, error: "Photo file is empty." };
  if (file.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: `Photo is too large (max ${MAX_PHOTO_BYTES / 1024 / 1024} MB).` };
  }
  const type = file.type.toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    return { ok: false, error: "Photo must be a JPEG, PNG, or WebP image." };
  }
  return { ok: true, contentType: type };
}

export async function storePhoto(
  recipeId: string,
  file: File,
  contentType: string,
): Promise<string> {
  const ext = MIME_TO_EXT[contentType] ?? "bin";
  const random = crypto.randomUUID();
  const key = `recipes/${recipeId}/${random}.${ext}`;
  const buf = await file.arrayBuffer();
  await recipeStore().set(key, buf, {
    metadata: { contentType },
  });
  return key;
}

export async function deletePhoto(key: string): Promise<void> {
  try {
    await recipeStore().delete(key);
  } catch {
    // Best-effort; orphan blobs are not user-visible.
  }
}

export async function readPhoto(
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const result = await recipeStore().getWithMetadata(key, { type: "arrayBuffer" });
  if (!result) return null;
  const md = result.metadata as { contentType?: string } | undefined;
  return {
    body: result.data,
    contentType: md?.contentType ?? "application/octet-stream",
  };
}
