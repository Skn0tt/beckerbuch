import type { Route } from "./+types/oauth.metadata";

function originFromRequest(request: Request): string {
  return new URL(request.url).origin;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const origin = originFromRequest(request);
  // RFC 9728 §3.1: clients build the metadata URL by inserting
  // `/.well-known/oauth-protected-resource` between the host and the resource
  // path, so for our resource at `/mcp` the path-suffixed form is
  // `/.well-known/oauth-protected-resource/mcp`. Accept both.
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["recipes:write"],
    });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["recipes:write"],
    });
  }
  throw new Response("Not found", { status: 404 });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
