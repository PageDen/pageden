import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { buildApp } from "../../src/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createWorkspace, createUser, addMember } from "../fixtures/seed.js";
import { hashToken } from "../../src/tokens.js";
import { env } from "../../src/env.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const FORBIDDEN_KEYS = ["passwordHash", "tokenHash", "storageKey"];
function assertNoSecretKeys(body: unknown) {
  JSON.stringify(body, (key, value) => {
    if (FORBIDDEN_KEYS.includes(key)) throw new Error(`leaked sensitive key: ${key}`);
    return value;
  });
}

describe("security", () => {
  it("tenant isolation: cannot reach another workspace's document by id", async () => {
    const a = await baseScenario();
    const wsB = await createWorkspace("WS B", "wsb");
    const intruder = await createUser("intruder@t.co");
    await addMember(wsB.id, intruder.id, "admin");
    const cookie = sessionFor(intruder.id);

    // No read access ⇒ existence is hidden uniformly (404), not leaked via 403.
    expect((await req({ method: "GET", url: `/api/documents/${a.docId}`, cookies: cookie })).statusCode).toBe(404);
    expect((await req({ method: "PUT", url: `/api/documents/${a.docId}`, cookies: cookie, payload: { baseVersion: a.version, content: "x" } })).statusCode).toBe(404);
    expect((await req({ method: "DELETE", url: `/api/documents/${a.docId}`, cookies: cookie })).statusCode).toBe(404);
    expect((await req({ method: "POST", url: `/api/documents/${a.docId}/rename`, cookies: cookie, payload: { slug: "x" } })).statusCode).toBe(404);
    expect((await req({ method: "GET", url: `/api/documents/${a.docId}/permissions`, cookies: cookie })).statusCode).toBe(404);
    // not listed in the intruder's own workspace
    expect((await req({ method: "GET", url: `/api/documents?workspaceId=${wsB.id}`, cookies: cookie })).json().documents).toHaveLength(0);
  });

  it("no response leaks password or token hashes / storage keys", async () => {
    const s = await baseScenario();
    const c = s.adminCookie;
    assertNoSecretKeys((await req({ method: "GET", url: "/api/me", cookies: c })).json());
    assertNoSecretKeys((await req({ method: "GET", url: "/api/workspaces/current", cookies: c })).json());
    assertNoSecretKeys((await req({ method: "GET", url: `/api/users?workspaceId=${s.ws.id}`, cookies: c })).json());
    assertNoSecretKeys((await req({ method: "POST", url: "/api/tokens", cookies: c, payload: { name: "T" } })).json());
    assertNoSecretKeys((await req({ method: "GET", url: "/api/tokens", cookies: c })).json());
    assertNoSecretKeys((await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: c })).json());
  });

  it("stores only the HMAC hash of a plugin token, never the raw value", async () => {
    const s = await baseScenario();
    const created = await req({ method: "POST", url: "/api/tokens", cookies: s.adminCookie, payload: { name: "T" } });
    const raw = created.json().token as string;
    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: created.json().id } });
    expect(row.tokenHash).toBe(hashToken(raw, env.tokenHashSecret));
    expect(row.tokenHash).not.toBe(raw);
    const rawMatch = await prisma.apiToken.findFirst({ where: { tokenHash: raw } });
    expect(rawMatch).toBeNull();
  });

  it("rate-limits repeated logins (429)", async () => {
    const prev = process.env.LOGIN_RATE_LIMIT_MAX;
    process.env.LOGIN_RATE_LIMIT_MAX = "3";
    const app = await buildApp();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" }, payload: { email: "nobody@t.co", password: "x" } });
        codes.push(res.statusCode);
      }
      // First 3 are allowed (invalid creds → 401), the 4th is rate-limited.
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await app.close();
      if (prev === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
      else process.env.LOGIN_RATE_LIMIT_MAX = prev;
    }
  });
});

describe("CSRF", () => {
  it("rejects an unsafe cookie request with a foreign Origin (403)", async () => {
    const s = await baseScenario();
    const res = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, headers: { origin: "https://evil.example" }, payload: { baseVersion: s.version, content: "x" } });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unsafe cookie request with no Origin/Referer (403)", async () => {
    const s = await baseScenario();
    const app = await getApp();
    const res = await app.inject({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, payload: { baseVersion: s.version, content: "x" } });
    expect(res.statusCode).toBe(403);
  });

  it("exempts bearer-token clients from the Origin check (plugins have no Origin)", async () => {
    const s = await baseScenario();
    const created = await req({ method: "POST", url: "/api/tokens", cookies: s.adminCookie, payload: { name: "T" } });
    const raw = created.json().token as string;
    const app = await getApp();
    const res = await app.inject({ method: "POST", url: `/api/documents/${s.docId}/push`, headers: { authorization: `Bearer ${raw}` }, payload: { baseVersion: s.version, content: "# via plugin\n" } });
    expect(res.statusCode).toBe(200);
  });

  it("rate-limits repeated change-password attempts (429)", async () => {
    const u = await createUser("rl@t.co");
    const prev = process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX;
    process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX = "3";
    const app = await buildApp();
    try {
      const cookie = `pm_session=${sessionFor(u.id).pm_session}`;
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/change-password",
          headers: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", cookie },
          payload: { currentPassword: "wrong-password", newPassword: "BrandNew-pw-99999999" },
        });
        codes.push(res.statusCode);
      }
      // First 3 reach the handler (wrong current → 400), the 4th is rate-limited.
      expect(codes).toEqual([400, 400, 400, 429]);
    } finally {
      await app.close();
      if (prev === undefined) delete process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX;
      else process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX = prev;
    }
  });

  it("can disable open self-signup via AUTH_ALLOW_SIGNUP=false (403)", async () => {
    const prev = process.env.AUTH_ALLOW_SIGNUP;
    process.env.AUTH_ALLOW_SIGNUP = "false";
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" },
        payload: { email: "blocked@t.co", name: "Blocked", password: "Signup-pw-123456789" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
      if (prev === undefined) delete process.env.AUTH_ALLOW_SIGNUP;
      else process.env.AUTH_ALLOW_SIGNUP = prev;
    }
  });
});
