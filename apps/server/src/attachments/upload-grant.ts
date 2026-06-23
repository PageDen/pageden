// Short-lived, HMAC-signed grant that authorizes a single raw-binary attachment
// upload (PUT /api/attachments/upload). Lets an agent request an upload URL over
// MCP and then stream the file directly, instead of base64-in-JSON. The grant
// is self-contained (no DB row) and tamper-evident; the upload endpoint re-checks
// the uploader's permission when it fires.
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

export const UPLOAD_GRANT_TTL_SECONDS = 15 * 60;

export interface UploadGrant {
  workspaceId: string;
  documentId: string;
  userId: string;
  filename: string;
  contentType: string;
  maxBytes: number;
}

function sign(body: string): string {
  return createHmac("sha256", env.tokenHashSecret).update(body).digest("base64url");
}

export function signUploadGrant(grant: UploadGrant, now = Date.now()): string {
  const payload = { ...grant, exp: Math.floor(now / 1000) + UPLOAD_GRANT_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyUploadGrant(token: string | undefined, now = Date.now()): UploadGrant | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: UploadGrant & { exp?: number };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadGrant & { exp?: number };
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 < now) return null;
  if (!payload.documentId || !payload.userId || !payload.filename || !payload.contentType) return null;
  return {
    workspaceId: payload.workspaceId,
    documentId: payload.documentId,
    userId: payload.userId,
    filename: payload.filename,
    contentType: payload.contentType,
    maxBytes: payload.maxBytes,
  };
}
