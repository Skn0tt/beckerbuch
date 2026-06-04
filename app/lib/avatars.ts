import { getBlobStore } from "./storage";

const STORE_NAME = "avatars";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export type AvatarValidationError = string;

export const AVATAR_MAX_BYTES = MAX_AVATAR_BYTES;

function avatarStore() {
  return getBlobStore(STORE_NAME);
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
  const store = await avatarStore();
  return store.put(key, buf, contentType);
}

export async function deleteAvatar(key: string): Promise<void> {
  const store = await avatarStore();
  await store.del(key);
}

export async function readAvatar(
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const store = await avatarStore();
  return store.get(key);
}
