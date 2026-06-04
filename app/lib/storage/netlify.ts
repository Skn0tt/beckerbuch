import { getStore } from "@netlify/blobs";
import type { BlobStore, StoredObject } from "./index";

// Netlify Blobs driver. The handle is the key we were given — Netlify
// addresses objects by key, and reads stream back through the function.
export function createNetlifyStore(name: string): BlobStore {
  const store = () => getStore({ name, consistency: "strong" });

  return {
    async put(key, bytes, contentType) {
      await store().set(key, bytes, { metadata: { contentType } });
      return key;
    },

    async get(handle): Promise<StoredObject | null> {
      const result = await store().getWithMetadata(handle, {
        type: "arrayBuffer",
      });
      if (!result) return null;
      const md = result.metadata as { contentType?: string } | undefined;
      return {
        body: result.data,
        contentType: md?.contentType ?? "application/octet-stream",
      };
    },

    async del(handle) {
      try {
        await store().delete(handle);
      } catch {
        // Best-effort; orphan blobs are not user-visible.
      }
    },
  };
}
