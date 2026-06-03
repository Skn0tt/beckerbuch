import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { sessions, users, flatMembers, flats } from "../db/schema";
import { hashSessionToken, readSessionTokenFromRequest } from "./session";

export type AuthedContext = {
  session: { id: string };
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarKey: string | null;
  };
  flat: { id: string; name: string };
};

/**
 * Loader/action guard. On success returns `{ user, flat, session }`.
 * On failure: loaders get a `redirect("/login?redirect=…")`, actions
 * get a thrown 401 Response.
 */
export async function requireFlatMember(request: Request): Promise<AuthedContext> {
  const ctx = await tryGetAuthedContext(request);
  if (ctx) return ctx;

  const isMutation = request.method !== "GET" && request.method !== "HEAD";
  if (isMutation) {
    throw new Response("Unauthorized", { status: 401 });
  }
  const url = new URL(request.url);
  const target = url.pathname + url.search;
  throw redirect(`/login?redirect=${encodeURIComponent(target)}`);
}

// Per-request memoization. The same Request flows through every loader
// in the route chain (_app, _workspace, the leaf), and several loaders
// independently call tryGetAuthedContext / requireFlatMember — that
// used to be 3 identical session-lookup queries per page load. The
// WeakMap is keyed by the Request object so it auto-evicts when the
// request finishes; no manual lifecycle to manage.
const authCache: WeakMap<Request, Promise<AuthedContext | null>> = new WeakMap();

/** Same lookup as requireFlatMember but returns null instead of throwing. */
export function tryGetAuthedContext(
  request: Request,
): Promise<AuthedContext | null> {
  const cached = authCache.get(request);
  if (cached) return cached;
  const promise = loadAuthedContext(request);
  authCache.set(request, promise);
  return promise;
}

async function loadAuthedContext(
  request: Request,
): Promise<AuthedContext | null> {
  const token = readSessionTokenFromRequest(request);
  if (!token) return null;
  const sessionId = hashSessionToken(token);

  const rows = await db()
    .select({
      sessionId: sessions.id,
      userId: users.id,
      userEmail: users.email,
      userDisplayName: users.displayName,
      userAvatarKey: users.avatarBlobKey,
      flatId: flats.id,
      flatName: flats.name,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(flatMembers, eq(flatMembers.userId, users.id))
    .innerJoin(flats, eq(flats.id, flatMembers.flatId))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    session: { id: row.sessionId },
    user: {
      id: row.userId,
      email: row.userEmail,
      displayName: row.userDisplayName,
      avatarKey: row.userAvatarKey,
    },
    flat: { id: row.flatId, name: row.flatName },
  };
}
