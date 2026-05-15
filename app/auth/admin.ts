/**
 * Guard for /admin/* endpoints. Verifies the X-Admin-Token header against
 * the ADMIN_TOKEN env var (used in tests + provisioning scripts; never
 * set in production deployments). When the env var is missing we respond
 * 404 — that way production never advertises the endpoint's existence.
 *
 * Returns `null` when the request is allowed, or a `Response` that the
 * action should `return` directly. We use the return-a-Response pattern
 * (rather than throw) because React Router converts thrown responses
 * from actions into route error responses, which lose the original status.
 *
 * Note: we use 401 (not 403) for missing/bad credentials. It's the
 * semantically correct status, and `netlify dev` happens to replace 403
 * responses from functions with its own 404 fallback page.
 */
export function checkAdmin(request: Request): Response | null {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const provided = request.headers.get("x-admin-token");
  if (!provided || !timingSafeStringEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
