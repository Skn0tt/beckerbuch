// Tiny MIME table for fulfill({ path }). Deliberately not exhaustive —
// the lib is for tests, and bringing in a 1000-entry mime-db just to
// fulfill a fixture would dwarf the actual implementation. Add more
// entries if a test surfaces a real need.

import { extname } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
};

export function inferContentType(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()];
}
