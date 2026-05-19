import { createHmac, randomBytes, createHash } from "node:crypto";
import { constantTimeStringEqual } from "./timing-safe";

export const SESSION_COOKIE_NAME = "cb_session";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set (>= 16 chars)");
  }
  return secret;
}

/** Create a fresh session bearer token (the value we put in the cookie). */
export function createSessionToken(): string {
  return base64url(randomBytes(32));
}

/**
 * Hash the bearer token before storing in the DB. If the DB ever leaks,
 * the row values aren't usable as session cookies — the attacker would
 * need to brute-force the 32-byte preimage.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Sign the token so request-level tampering is detectable. Format: `<sig>.<token>`. */
export function signSessionCookieValue(token: string): string {
  const sig = base64url(
    createHmac("sha256", getSessionSecret()).update(token).digest(),
  );
  return `${sig}.${token}`;
}

/** Returns the bare token if signature is valid, null otherwise. */
export function verifySessionCookieValue(value: string): string | null {
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const sig = value.slice(0, dot);
  const token = value.slice(dot + 1);
  const expected = base64url(
    createHmac("sha256", getSessionSecret()).update(token).digest(),
  );
  if (!constantTimeStringEqual(sig, expected)) return null;
  return token;
}

export function buildSetSessionCookie(token: string): string {
  return cookieString({
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(token),
    maxAge: ONE_YEAR_SECONDS,
  });
}

export function buildClearSessionCookie(): string {
  return cookieString({
    name: SESSION_COOKIE_NAME,
    value: "",
    maxAge: 0,
  });
}

export function readSessionTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const raw = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!raw) return null;
  return verifySessionCookieValue(raw);
}

function cookieString(opts: { name: string; value: string; maxAge: number }): string {
  const parts = [
    `${opts.name}=${opts.value}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${opts.maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}
