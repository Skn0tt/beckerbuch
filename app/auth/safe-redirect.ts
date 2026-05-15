/**
 * Returns `to` if it's a same-origin path, otherwise `fallback`.
 * Blocks open-redirects from `?redirect=` and similar params.
 *
 * Allowed:  "/", "/recipes", "/recipes?q=foo"
 * Blocked:  "https://evil", "//evil", "javascript:…", "" / null
 */
export function safeRedirectTarget(
  to: string | null | undefined,
  fallback = "/",
): string {
  if (!to) return fallback;
  // Must start with a single forward slash.
  if (to[0] !== "/") return fallback;
  // Reject protocol-relative ("//evil") and backslash variants.
  if (to[1] === "/" || to[1] === "\\") return fallback;
  return to;
}
