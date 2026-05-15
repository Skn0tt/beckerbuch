const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const attempts = new Map<string, number[]>();

/**
 * In-memory login rate limiter, keyed by lowercased email. v1 only —
 * fine for our single-flat use case. Move to a DB table the moment we
 * ship to anyone outside our flat (TECH.md §4.4).
 */
export function checkLoginRateLimit(email: string): { allowed: boolean; retryAfterMs: number } {
  const key = email.trim().toLowerCase();
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, recent);
  if (recent.length >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: WINDOW_MS - (now - recent[0]) };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function recordLoginFailure(email: string): void {
  const key = email.trim().toLowerCase();
  const recent = attempts.get(key) ?? [];
  recent.push(Date.now());
  attempts.set(key, recent);
}

export function clearLoginAttempts(email: string): void {
  attempts.delete(email.trim().toLowerCase());
}

/** Test-only — wipes all state. */
export function _resetRateLimiter(): void {
  attempts.clear();
}
