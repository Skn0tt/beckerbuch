/**
 * For unauthenticated mutating endpoints (signup via invite), we don't have
 * a session-bound CSRF token to check. As a belt-and-braces measure on top
 * of SameSite=Lax, verify the request's Origin (or Referer) matches our
 * own origin.
 */
export function isSameOrigin(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === requestOrigin;
  // Fall back to Referer for clients that don't send Origin.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin;
    } catch {
      return false;
    }
  }
  // No Origin and no Referer → reject.
  return false;
}
