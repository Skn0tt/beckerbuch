import { getStore } from "@netlify/blobs";

const STORE_NAME = "avatars";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export type AvatarValidationError = string;

export const AVATAR_MAX_BYTES = MAX_AVATAR_BYTES;

function avatarStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export type AvatarValidationResult =
  | { ok: true; contentType: string }
  | { ok: false; error: AvatarValidationError };

export function validateAvatarBytes(
  size: number,
  contentType: string,
): AvatarValidationResult {
  if (size === 0) return { ok: false, error: "Avatar file is empty." };
  if (size > MAX_AVATAR_BYTES) {
    return {
      ok: false,
      error: `Avatar is too large (max ${MAX_AVATAR_BYTES / 1024 / 1024} MB).`,
    };
  }
  const type = contentType.toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    return { ok: false, error: "Avatar must be a JPEG, PNG, or WebP image." };
  }
  return { ok: true, contentType: type };
}

export function validateAvatar(file: File): AvatarValidationResult {
  return validateAvatarBytes(file.size, file.type);
}

export async function storeAvatar(
  userId: string,
  file: File,
  contentType: string,
): Promise<string> {
  const buf = await file.arrayBuffer();
  const key = `avatars/${userId}/${crypto.randomUUID()}`;
  await avatarStore().set(key, buf, {
    metadata: { contentType },
  });
  return key;
}

export async function deleteAvatar(key: string): Promise<void> {
  try {
    await avatarStore().delete(key);
  } catch {
    // Best-effort cleanup: missing keys and transient blob-store errors
    // should not block profile updates/removals.
  }
}

export async function readAvatar(
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const result = await avatarStore().getWithMetadata(key, { type: "arrayBuffer" });
  if (!result) return null;
  const md = result.metadata as { contentType?: string } | undefined;
  return {
    body: result.data,
    contentType: md?.contentType ?? "application/octet-stream",
  };
}
