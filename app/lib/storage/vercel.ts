import { put, del } from "@vercel/blob";
import type { BlobStore, StoredObject } from "./index";

// Vercel Blob driver. Keys are already namespaced (`recipes/…`,
// `avatars/…`) so a single Vercel Blob store holds both buckets; `name`
// is unused for addressing. `addRandomSuffix: false` keeps the pathname
// equal to our key, and the handle we persist is the returned blob URL.
//
// Auth is resolved inside @vercel/blob: it uses BLOB_READ_WRITE_TOKEN if
// present, otherwise the OIDC setup (runtime-injected VERCEL_OIDC_TOKEN +
// BLOB_STORE_ID). Either way we pass no token here.
//
// Vercel Blob is public-read: the URL is fetchable by anyone who has it.
// Our keys embed an unguessable random component and we still serve
// through the existing auth/token-gated routes, so this is acceptable —
// see TECH.md §8.
export function createVercelStore(_name: string): BlobStore {
  return {
    async put(key, bytes, contentType) {
      const result = await put(key, bytes, {
        access: "public",
        contentType,
        addRandomSuffix: false,
      });
      return result.url;
    },

    async get(handle): Promise<StoredObject | null> {
      const res = await fetch(handle);
      if (!res.ok) return null;
      const body = await res.arrayBuffer();
      return {
        body,
        contentType:
          res.headers.get("content-type") ?? "application/octet-stream",
      };
    },

    async del(handle) {
      try {
        await del(handle);
      } catch {
        // Best-effort; orphan blobs are not user-visible.
      }
    },
  };
}
