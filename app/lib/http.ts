/**
 * Small shared fetch helpers used by the recipe importers.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * fetch() with an AbortController-backed timeout. Always clears the
 * timer, even on throw.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
