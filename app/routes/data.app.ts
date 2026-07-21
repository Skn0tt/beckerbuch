import type { Route } from "./+types/data.app";
import { tryGetAuthedContext } from "../auth/require";

/**
 * JSON bootstrap for the authenticated app chrome. Used by `_app` when
 * hydrating from a CDN shell (prerendered HTML has no real session payload).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await tryGetAuthedContext(request);
  if (!ctx) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return Response.json({
    user: ctx.user,
    flat: ctx.flat,
  });
}
