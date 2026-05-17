import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthTokens,
} from "../db/schema";

export const SUPPORTED_SCOPE = "recipes:write";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTH_CODE_TTL_SECONDS = 10 * 60;

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** PKCE: verify base64url(SHA-256(verifier)) == challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return constantTimeEqual(computed, challenge);
}

// ---------- client registration ----------

export type RegisteredClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
};

export async function registerClient(input: {
  clientName: string;
  redirectUris: string[];
}): Promise<RegisteredClient> {
  const clientId = `mcp_${randomBytes(16).toString("base64url")}`;
  await db().insert(oauthClients).values({
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
  });
  return {
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
  };
}

export async function getClient(clientId: string): Promise<RegisteredClient | null> {
  const rows = await db()
    .select({
      clientId: oauthClients.clientId,
      clientName: oauthClients.clientName,
      redirectUris: oauthClients.redirectUris,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row;
}

// ---------- authorization codes ----------

export async function issueAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
}): Promise<string> {
  const code = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000);
  await db().insert(oauthAuthorizationCodes).values({
    codeHash: hashToken(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
    scope: input.scope,
    expiresAt,
  });
  return code;
}

export type AuthCodeRow = {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: Date;
  usedAt: Date | null;
};

/**
 * Atomically claim an auth code: mark it used and return its row only if it
 * was previously unused and unexpired. Returns null otherwise.
 */
export async function consumeAuthorizationCode(
  code: string,
): Promise<AuthCodeRow | null> {
  const codeHash = hashToken(code);
  const now = new Date();
  const result = await db()
    .update(oauthAuthorizationCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, codeHash),
        isNull(oauthAuthorizationCodes.usedAt),
        gt(oauthAuthorizationCodes.expiresAt, now),
      ),
    )
    .returning({
      clientId: oauthAuthorizationCodes.clientId,
      userId: oauthAuthorizationCodes.userId,
      redirectUri: oauthAuthorizationCodes.redirectUri,
      codeChallenge: oauthAuthorizationCodes.codeChallenge,
      scope: oauthAuthorizationCodes.scope,
      expiresAt: oauthAuthorizationCodes.expiresAt,
      usedAt: oauthAuthorizationCodes.usedAt,
    });
  return result[0] ?? null;
}

// ---------- tokens ----------

export type IssuedTokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};

export async function issueTokenPair(input: {
  clientId: string;
  userId: string;
  scope: string;
  parentHash?: string | null;
}): Promise<IssuedTokenPair> {
  const accessToken = generateOpaqueToken();
  const refreshToken = generateOpaqueToken();
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  await db().insert(oauthTokens).values([
    {
      tokenHash: hashToken(accessToken),
      type: "access",
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      expiresAt: accessExpiresAt,
      parentHash: input.parentHash ?? null,
    },
    {
      tokenHash: hashToken(refreshToken),
      type: "refresh",
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      expiresAt: null,
      parentHash: input.parentHash ?? null,
    },
  ]);
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: input.scope,
  };
}

export type RefreshRotationResult =
  | { ok: true; pair: IssuedTokenPair }
  | { ok: false; error: "invalid_grant" };

/**
 * Rotate a refresh token: revoke the old one and issue a new pair.
 * Returns invalid_grant if the refresh is unknown, revoked, or wrong client.
 */
export async function rotateRefreshToken(input: {
  refreshToken: string;
  clientId: string;
}): Promise<RefreshRotationResult> {
  const oldHash = hashToken(input.refreshToken);
  const now = new Date();
  const claimed = await db()
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthTokens.tokenHash, oldHash),
        eq(oauthTokens.type, "refresh"),
        eq(oauthTokens.clientId, input.clientId),
        isNull(oauthTokens.revokedAt),
      ),
    )
    .returning({
      userId: oauthTokens.userId,
      scope: oauthTokens.scope,
    });
  const row = claimed[0];
  if (!row) return { ok: false, error: "invalid_grant" };
  const pair = await issueTokenPair({
    clientId: input.clientId,
    userId: row.userId,
    scope: row.scope,
    parentHash: oldHash,
  });
  return { ok: true, pair };
}
