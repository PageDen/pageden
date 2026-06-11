import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../../src/app.js";
import { sealSession, SESSION_COOKIE } from "../../src/session.js";
import { env } from "../../src/env.js";

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) app = await buildApp();
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

/** Seal a session cookie directly (bypasses the login route + its rate limit). */
export function sessionFor(userId: string, sessionVersion = 0): Record<string, string> {
  return { [SESSION_COOKIE]: sealSession(userId, sessionVersion, env.sessionSecret) };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Convenience request wrapper bound to the shared app. Sends a same-origin Origin header by
 *  default so cookie-authenticated unsafe requests pass the CSRF guard. */
export async function req(opts: InjectOptions) {
  const a = await getApp();
  const headers = { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", ...(opts.headers ?? {}) };
  return a.inject({ ...opts, headers });
}

/** Real login via the endpoint (for auth/security tests). Returns the session cookie value. */
export async function login(email: string, password: string): Promise<string> {
  const res = await req({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode}: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error("no session cookie returned");
  return cookie.value;
}
