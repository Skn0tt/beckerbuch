import type { Route } from "./+types/oauth.register";
import { registerClient } from "../auth/oauth";

type RegisterBody = {
  client_name?: unknown;
  redirect_uris?: unknown;
  scope?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
};

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return jsonError("invalid_request", "POST required", 405);
  }
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return jsonError("invalid_request", "JSON body required", 415);
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonError("invalid_request", "Body is not valid JSON");
  }

  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 200)
      : "Unnamed MCP client";

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return jsonError("invalid_redirect_uri", "redirect_uris required");
  }
  const redirectUris: string[] = [];
  for (const u of body.redirect_uris) {
    if (typeof u !== "string") {
      return jsonError("invalid_redirect_uri", "redirect_uris must be strings");
    }
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        return jsonError(
          "invalid_redirect_uri",
          "redirect_uri must be https or localhost",
        );
      }
    } catch {
      return jsonError("invalid_redirect_uri", "redirect_uri is not a URL");
    }
    redirectUris.push(u);
  }

  const client = await registerClient({ clientName, redirectUris });
  const scope =
    typeof body.scope === "string" && body.scope.trim()
      ? body.scope.trim()
      : "recipes:write";
  return new Response(
    JSON.stringify({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
    {
      status: 201,
      headers: { "content-type": "application/json" },
    },
  );
}

function jsonError(error: string, description: string, status = 400): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { "content-type": "application/json" } },
  );
}
