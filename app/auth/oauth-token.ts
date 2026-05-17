import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/client";
import { flatMembers, flats, oauthTokens, users } from "../db/schema";
import { hashToken } from "./oauth";
import type { AuthedContext } from "./require";

/**
 * Resolve an OAuth bearer token to an AuthedContext (user + their flat).
 * Returns null for any of: missing/malformed header, unknown token, wrong
 * type, expired, revoked, user no longer in a flat.
 */
export async function tryGetMcpContext(
  request: Request,
): Promise<AuthedContext | null> {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  const tokenHash = hashToken(token);
  const now = new Date();

  const rows = await db()
    .select({
      tokenHash: oauthTokens.tokenHash,
      userId: users.id,
      userEmail: users.email,
      userDisplayName: users.displayName,
      flatId: flats.id,
      flatName: flats.name,
    })
    .from(oauthTokens)
    .innerJoin(users, eq(users.id, oauthTokens.userId))
    .innerJoin(flatMembers, eq(flatMembers.userId, users.id))
    .innerJoin(flats, eq(flats.id, flatMembers.flatId))
    .where(
      and(
        eq(oauthTokens.tokenHash, tokenHash),
        eq(oauthTokens.type, "access"),
        isNull(oauthTokens.revokedAt),
        or(isNull(oauthTokens.expiresAt), gt(oauthTokens.expiresAt, now)),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    session: { id: row.tokenHash },
    user: {
      id: row.userId,
      email: row.userEmail,
      displayName: row.userDisplayName,
    },
    flat: { id: row.flatId, name: row.flatName },
  };
}
