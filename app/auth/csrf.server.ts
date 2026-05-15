import { createHmac, timingSafeEqual } from "node:crypto";
import { CSRF_FIELD_NAME, csrfFieldName } from "./csrf-shared";

export { csrfFieldName };

const CSRF_DOMAIN = "csrf:";

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set (>= 16 chars)");
  }
  return secret;
}

/**
 * Stateless per-session CSRF token. Derived from the session id via
 * HMAC, domain-separated from session signing by the "csrf:" prefix.
 * Same input → same token, so we don't need to store it.
 */
export function csrfTokenForSession(sessionId: string): string {
  return createHmac("sha256", getSecret())
    .update(CSRF_DOMAIN + sessionId)
    .digest("base64url");
}

export async function requireCsrf(
  request: Request,
  sessionId: string,
): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD") return;
  // Clone — the caller still needs the body. Form bodies don't double-read
  // cleanly across runtimes, so we read once and reattach.
  const form = await request.clone().formData();
  const submitted = form.get(CSRF_FIELD_NAME);
  if (typeof submitted !== "string") {
    throw new Response("CSRF token missing", { status: 403 });
  }
  const expected = csrfTokenForSession(sessionId);
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Response("CSRF token mismatch", { status: 403 });
  }
}
