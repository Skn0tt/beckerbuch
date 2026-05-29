import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { flatMembers, flats, users } from "../db/schema";
import type { AuthedContext } from "./require";

const UUID_SCHEMA = z.guid();

/**
 * Resolve a per-user MCP token to an AuthedContext (user + their flat).
 *
 * Token source order:
 *   1. `?token=<uuid>` search param (the form printed in the UI).
 *   2. `Authorization: Bearer <uuid>` header (fallback for clients that
 *      strip query strings or only do header auth).
 *
 * Returns null for any of: missing token, malformed (non-UUID) token,
 * unknown token, user not in a flat.
 */
export async function tryGetMcpContext(
  request: Request,
): Promise<AuthedContext | null> {
  const token = extractToken(request);
  if (!token) return null;
  if (!UUID_SCHEMA.safeParse(token).success) return null;

  const rows = await db()
    .select({
      userId: users.id,
      userEmail: users.email,
      userDisplayName: users.displayName,
      userAvatarKey: users.avatarBlobKey,
      flatId: flats.id,
      flatName: flats.name,
    })
    .from(users)
    .innerJoin(flatMembers, eq(flatMembers.userId, users.id))
    .innerJoin(flats, eq(flats.id, flatMembers.flatId))
    .where(eq(users.mcpToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    // No real session for MCP — use the token itself as a stable id
    // for any logging/debugging that wants something to key off.
    session: { id: `mcp:${row.userId}` },
    user: {
      id: row.userId,
      email: row.userEmail,
      displayName: row.userDisplayName,
      avatarKey: row.userAvatarKey,
    },
    flat: { id: row.flatId, name: row.flatName },
  };
}

function extractToken(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();

  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const token = m[1].trim();
  return token || null;
}
