// Header-shape helpers shared by Request / Response wrappers and the
// outbound Route.continue/fetch path.

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** Lower-case keys, multi-value joined with `, ` — Playwright's headers() shape. */
export function normaliseHeaders(
  rawHeaders: Array<[string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of rawHeaders) {
    const kl = k.toLowerCase();
    out[kl] = kl in out ? `${out[kl]}, ${v}` : v;
  }
  return out;
}

/** First value for `name` (case-insensitive). */
export function firstHeader(
  rawHeaders: Array<[string, string]>,
  name: string,
): string | null {
  const n = name.toLowerCase();
  for (const [k, v] of rawHeaders) {
    if (k.toLowerCase() === n) return v;
  }
  return null;
}

/** All values for `name` (case-insensitive), in occurrence order. */
export function allValues(
  rawHeaders: Array<[string, string]>,
  name: string,
): string[] {
  const n = name.toLowerCase();
  const out: string[] = [];
  for (const [k, v] of rawHeaders) {
    if (k.toLowerCase() === n) out.push(v);
  }
  return out;
}

export function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "DELETE" && m !== "OPTIONS";
}

export function toUint8(buf: string | Buffer | Uint8Array): Uint8Array {
  if (typeof buf === "string") return new TextEncoder().encode(buf);
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
