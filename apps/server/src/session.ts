import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "pm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

interface SessionPayload {
  userId: string;
  v: number; // user.sessionVersion at issue time — lets a password change/reset invalidate cookies
  exp: number;
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function sealSession(userId: string, sessionVersion: number, secret: string, now = Date.now()): string {
  const payload: SessionPayload = {
    userId,
    v: sessionVersion,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function openSession(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): { userId: string; v: number } | null {
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;

  const expected = sign(body, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.userId || payload.exp < Math.floor(now / 1000)) return null;
    return { userId: payload.userId, v: typeof payload.v === "number" ? payload.v : 0 };
  } catch {
    return null;
  }
}
