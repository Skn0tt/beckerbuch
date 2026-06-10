import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/logout";
import { db } from "../db/client";
import { sessions } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf } from "../auth/csrf.server";
import { buildClearSessionCookie } from "../auth/session";

export async function action({ request }: Route.ActionArgs) {
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);
  await db().delete(sessions).where(eq(sessions.id, ctx.session.id));
  return redirect("/login", {
    headers: { "Set-Cookie": buildClearSessionCookie() },
  });
}

export async function loader() {
  // POST-only.
  throw redirect("/");
}
