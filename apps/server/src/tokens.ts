import { createHmac, randomBytes } from "node:crypto";

// Plugin tokens are looked up by hash, so the hash MUST be deterministic (review B5).
// HMAC-SHA256 keyed by TOKEN_HASH_SECRET — never bcrypt/argon2 (those are for passwords).
export function hashToken(rawToken: string, tokenHashSecret: string): string {
  return createHmac("sha256", tokenHashSecret).update(rawToken).digest("hex");
}

export const TOKEN_PREFIX = "pm_live_";

export function createRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}
