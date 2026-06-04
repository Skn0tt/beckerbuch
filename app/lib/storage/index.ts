// Provider-agnostic blob storage. Two drivers — Netlify Blobs (default,
// what the test rig and CI exercise) and Vercel Blob — behind one small
// interface so app code (recipe photos, avatars) never imports a vendor
// SDK directly.
//
// A "handle" is the opaque string the app persists (e.g. into
// recipes.photo_blob_key). On Netlify it is the store key we generated; on
// Vercel it is the blob URL `put` returns. Callers must treat it as opaque
// and round-trip it back into `get`/`del` unchanged.

export type StoredObject = { body: ArrayBuffer; contentType: string };

export interface BlobStore {
  /** Store bytes under `key`. Returns the handle to persist. */
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<string>;
  /** Read by handle. Null if missing. */
  get(handle: string): Promise<StoredObject | null>;
  /** Best-effort delete by handle. */
  del(handle: string): Promise<void>;
}

export type StorageDriver = "netlify" | "vercel";

/**
 * Pick the driver. Explicit STORAGE_DRIVER wins; otherwise auto-detect
 * Vercel by its blob env. Two shapes are recognised: the classic static
 * `BLOB_READ_WRITE_TOKEN`, and the current OIDC setup, which exposes
 * `BLOB_STORE_ID` (auth comes from the runtime-injected VERCEL_OIDC_TOKEN,
 * resolved inside @vercel/blob). Defaults to Netlify so the test rig (no
 * blob env) and the default build stay on the existing path.
 */
export function resolveStorageDriver(): StorageDriver {
  const explicit = process.env.STORAGE_DRIVER?.toLowerCase();
  if (explicit === "vercel" || explicit === "netlify") return explicit;
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
    return "vercel";
  }
  return "netlify";
}

/**
 * Get a store bound to the named bucket (`recipes`, `avatars`). The driver
 * is resolved per call so a single process picks up env consistently.
 */
export async function getBlobStore(name: string): Promise<BlobStore> {
  if (resolveStorageDriver() === "vercel") {
    const { createVercelStore } = await import("./vercel");
    return createVercelStore(name);
  }
  const { createNetlifyStore } = await import("./netlify");
  return createNetlifyStore(name);
}
