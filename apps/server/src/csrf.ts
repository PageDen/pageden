import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env.js";
import { SESSION_COOKIE } from "./session.js";

const UNSAFE = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// CSRF defense for cookie-authenticated browser requests. For unsafe methods we require the
// request's Origin (or Referer) to match WEB_ORIGIN. Token (bearer) clients are exempt: an
// attacker page cannot set an Authorization header cross-site, so they are not CSRF-able.
// SameSite=Lax alone is insufficient for an admin-capable app, so this is enforced server-side.
export function csrfGuard(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  if (!UNSAFE.has(request.method)) return done();
  // Device-code endpoints are called by the (non-browser) plugin with no cookie/Origin and
  // carry no ambient credential, so they are not CSRF-able. (Approval is a separate
  // cookie-authenticated endpoint that IS Origin-checked.)
  const path = request.url.split("?")[0];
  if (path === "/api/auth/device/start" || path === "/api/auth/device/poll" || path === "/oauth/token") return done();
  // Exempt ONLY genuine token clients: no session cookie AND a Bearer header. (Server auth
  // prefers the cookie, so any cookie-bearing request acts as the session user and must be
  // CSRF-checked even if an Authorization header is also present.)
  const hasSessionCookie = Boolean(request.cookies?.[SESSION_COOKIE]);
  const isBearer = /^Bearer\s+/i.test(request.headers.authorization ?? "");
  if (!hasSessionCookie && isBearer) return done();
  const candidate = (request.headers.origin as string | undefined) ?? originOf(request.headers.referer);
  if (candidate !== null && candidate === env.webOrigin) return done();
  reply.code(403).send({ error: "forbidden", message: "Invalid or missing request origin." });
}
