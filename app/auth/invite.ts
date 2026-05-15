import { randomBytes } from "node:crypto";

/** 16 random bytes → ~22-char base64url. Per TECH.md §3.1. */
export function generateInviteToken(): string {
  return randomBytes(16).toString("base64url");
}
