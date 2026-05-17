import type { Route } from "./+types/oauth.token";
import {
  SUPPORTED_SCOPE,
  consumeAuthorizationCode,
  getClient,
  issueTokenPair,
  rotateRefreshToken,
  verifyPkceS256,
  constantTimeEqual,
} from "../auth/oauth";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }

  const form = await readForm(request);
  if (!form) {
    return jsonError(
      "invalid_request",
      "Body must be application/x-www-form-urlencoded",
      415,
    );
  }

  const grantType = (form.get("grant_type") ?? "").toString();

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(form);
  }
  if (grantType === "refresh_token") {
    return handleRefresh(form);
  }
  return jsonError("unsupported_grant_type", `unsupported: ${grantType}`);
}

async function handleAuthorizationCode(form: URLSearchParams): Promise<Response> {
  const code = (form.get("code") ?? "").toString();
  const clientId = (form.get("client_id") ?? "").toString();
  const redirectUri = (form.get("redirect_uri") ?? "").toString();
  const verifier = (form.get("code_verifier") ?? "").toString();

  if (!code || !clientId || !redirectUri || !verifier) {
    return jsonError(
      "invalid_request",
      "code, client_id, redirect_uri, code_verifier required",
    );
  }

  const client = await getClient(clientId);
  if (!client) return jsonError("invalid_client", "unknown client", 401);

  // Atomically claim the code so a replay can't redeem twice.
  const row = await consumeAuthorizationCode(code);
  if (!row) return jsonError("invalid_grant", "code invalid, used, or expired");

  if (!constantTimeEqual(row.clientId, clientId)) {
    return jsonError("invalid_grant", "code/client mismatch");
  }
  if (!constantTimeEqual(row.redirectUri, redirectUri)) {
    return jsonError("invalid_grant", "redirect_uri mismatch");
  }
  if (!verifyPkceS256(verifier, row.codeChallenge)) {
    return jsonError("invalid_grant", "PKCE verifier mismatch");
  }

  const pair = await issueTokenPair({
    clientId,
    userId: row.userId,
    scope: row.scope,
  });
  return tokenResponse(pair);
}

async function handleRefresh(form: URLSearchParams): Promise<Response> {
  const refreshToken = (form.get("refresh_token") ?? "").toString();
  const clientId = (form.get("client_id") ?? "").toString();
  const requestedScope = (form.get("scope") ?? SUPPORTED_SCOPE).toString();

  if (!refreshToken || !clientId) {
    return jsonError("invalid_request", "refresh_token and client_id required");
  }
  if (requestedScope !== SUPPORTED_SCOPE) {
    return jsonError("invalid_scope", `only ${SUPPORTED_SCOPE} supported`);
  }

  const client = await getClient(clientId);
  if (!client) return jsonError("invalid_client", "unknown client", 401);

  const result = await rotateRefreshToken({ refreshToken, clientId });
  if (!result.ok) return jsonError("invalid_grant", "refresh invalid or revoked");
  return tokenResponse(result.pair);
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/x-www-form-urlencoded")) return null;
  const text = await request.text();
  return new URLSearchParams(text);
}

function tokenResponse(pair: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}): Response {
  return new Response(
    JSON.stringify({
      access_token: pair.accessToken,
      token_type: "Bearer",
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      scope: pair.scope,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

function jsonError(error: string, description: string, status = 400): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}
