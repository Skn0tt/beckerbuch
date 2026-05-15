import argon2 from "argon2";

// OWASP 2024 baseline for argon2id. memoryCost is in KiB (libargon2 unit) —
// 19 MiB = 19 * 1024.
const DEFAULT_MEMORY_COST_KIB = 19 * 1024;
const DEFAULT_TIME_COST = 2;
const DEFAULT_PARALLELISM = 1;

const params = {
  type: argon2.argon2id,
  memoryCost: parseIntEnv("ARGON2_MEMORY_KIB", DEFAULT_MEMORY_COST_KIB),
  timeCost: parseIntEnv("ARGON2_TIME_COST", DEFAULT_TIME_COST),
  parallelism: parseIntEnv("ARGON2_PARALLELISM", DEFAULT_PARALLELISM),
} as const;

// Cap input to prevent argon2-burns-CPU DoS. NIST 800-63B suggests no
// composition rules but a generous max is fine — 1 KiB is way over any
// password a human types.
export const MAX_PASSWORD_BYTES = 1024;
export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  assertPasswordSize(password);
  return argon2.hash(password, params);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return Promise.resolve(false);
  return argon2.verify(hash, password);
}

let dummyHashPromise: Promise<string> | null = null;
/**
 * A throw-away argon2id hash with the same params as real users, used so
 * that login attempts against non-existent emails take the same wall time
 * as real ones (no email-enumeration via timing).
 */
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash("dummy-password-for-timing-safety", params);
  }
  return dummyHashPromise;
}

export function assertPasswordSize(password: string): void {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(`Password exceeds max length (${MAX_PASSWORD_BYTES} bytes)`);
  }
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}=${raw}`);
  }
  return n;
}
