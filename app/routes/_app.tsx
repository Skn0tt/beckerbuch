import { Outlet, redirect } from "react-router";
import type { Route } from "./+types/_app";
import { tryGetAuthedContext } from "../auth/require";
import { csrfTokenForSession } from "../auth/csrf.server";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await tryGetAuthedContext(request);
  if (!ctx) {
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    throw redirect(`/login?redirect=${encodeURIComponent(target)}`);
  }
  return {
    user: ctx.user,
    flat: ctx.flat,
    csrfToken: csrfTokenForSession(ctx.session.id),
  };
}

export default function AppLayout() {
  return <Outlet />;
}
