import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, sessionFor, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { createUser, createWorkspace, addMember, PW } from "../fixtures/seed.js";
import { setMailer } from "../../src/mailer.js";
import { createRawToken, hashToken } from "../../src/tokens.js";
import { env } from "../../src/env.js";

let lastReset: { to: string; url: string } | null = null;
let lastVerify: { to: string; url: string } | null = null;
beforeEach(() => {
  lastReset = null;
  lastVerify = null;
  setMailer({
    async sendPasswordReset(to, url) {
      lastReset = { to, url };
    },
    async sendEmailVerification(to, url) {
      lastVerify = { to, url };
    },
  });
});

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function adminUser() {
  const ws = await createWorkspace();
  const user = await createUser("admin@t.co", "Admin");
  await addMember(ws.id, user.id, "admin");
  return { ws, user };
}

describe("auth", () => {
  it("logs in with valid credentials and sets a session cookie", async () => {
    await adminUser();
    const res = await req({ method: "POST", url: "/api/auth/login", payload: { email: "admin@t.co", password: PW } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === "pm_session")).toBeTruthy();
    expect(res.json().user.email).toBe("admin@t.co");
  });

  it("rejects a wrong password with 401 and records an audit event", async () => {
    await adminUser();
    const res = await req({ method: "POST", url: "/api/auth/login", payload: { email: "admin@t.co", password: "wrong-password" } });
    expect(res.statusCode).toBe(401);
    const failed = await prisma.auditEvent.findFirst({ where: { action: "login_failed" } });
    expect(failed).toBeTruthy();
  });

  it("400s on missing credentials", async () => {
    const res = await req({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });

  it("requires auth for /me and returns the user via session", async () => {
    const { user } = await adminUser();
    const anon = await req({ method: "GET", url: "/api/me" });
    expect(anon.statusCode).toBe(401);
    const me = await req({ method: "GET", url: "/api/me", cookies: sessionFor(user.id) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);
    expect(me.json().workspaces[0].role).toBe("admin");
  });

  it("requires auth for the current workspace endpoint", async () => {
    const anon = await req({ method: "GET", url: "/api/workspaces/current" });
    expect(anon.statusCode).toBe(401);
  });

  it("authenticates /me via a plugin bearer token", async () => {
    const { user } = await adminUser();
    const created = await req({ method: "POST", url: "/api/tokens", cookies: sessionFor(user.id), payload: { name: "My Mac" } });
    expect(created.statusCode).toBe(201);
    const raw = created.json().token as string;
    expect(raw.startsWith("pm_live_")).toBe(true);
    const me = await req({ method: "GET", url: "/api/me", headers: bearer(raw) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);
  });

  it("authenticates the current workspace endpoint via a plugin bearer token", async () => {
    const { ws, user } = await adminUser();
    const created = await req({ method: "POST", url: "/api/tokens", cookies: sessionFor(user.id), payload: { name: "My Mac" } });
    const raw = created.json().token as string;
    const current = await req({ method: "GET", url: "/api/workspaces/current", headers: bearer(raw) });
    expect(current.statusCode).toBe(200);
    expect(current.json().workspace.id).toBe(ws.id);
    expect(current.json().routingMode).toBe("self_hosted");
  });

  it("rejects a revoked token with 401", async () => {
    const { user } = await adminUser();
    const created = await req({ method: "POST", url: "/api/tokens", cookies: sessionFor(user.id), payload: { name: "T" } });
    const raw = created.json().token as string;
    const id = created.json().id as string;
    await req({ method: "POST", url: `/api/tokens/${id}/revoke`, cookies: sessionFor(user.id) });
    const me = await req({ method: "GET", url: "/api/me", headers: bearer(raw) });
    expect(me.statusCode).toBe(401);
  });

  it("rejects an expired token with 401", async () => {
    const { user } = await adminUser();
    const created = await req({ method: "POST", url: "/api/tokens", cookies: sessionFor(user.id), payload: { name: "T" } });
    const raw = created.json().token as string;
    const id = created.json().id as string;
    await prisma.apiToken.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const me = await req({ method: "GET", url: "/api/me", headers: bearer(raw) });
    expect(me.statusCode).toBe(401);
  });

  it("logs out", async () => {
    const { user } = await adminUser();
    const res = await req({ method: "POST", url: "/api/auth/logout", cookies: sessionFor(user.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("a plugin bearer token authorizes a mutating route (push)", async () => {
    const { ws, user } = await adminUser();
    const fc = await req({ method: "POST", url: "/api/folders", cookies: sessionFor(user.id), payload: { workspaceId: ws.id, name: "F", slug: "f" } });
    const dc = await req({ method: "POST", url: "/api/documents", cookies: sessionFor(user.id), payload: { workspaceId: ws.id, folderId: fc.json().id, title: "D", slug: "d", content: "# a\n" } });
    const created = await req({ method: "POST", url: "/api/tokens", cookies: sessionFor(user.id), payload: { name: "Plugin" } });
    const raw = created.json().token as string;
    const push = await req({ method: "POST", url: `/api/documents/${dc.json().id}/push`, headers: bearer(raw), payload: { baseVersion: dc.json().version, content: "# b\n" } });
    expect(push.statusCode).toBe(200);
    expect(push.json().version).not.toBe(dc.json().version);
    const rev = await prisma.documentRevision.findUniqueOrThrow({ where: { id: push.json().version } });
    expect(rev.changeSource).toBe("obsidian_plugin");
  });
});

describe("change password", () => {
  it("changes the password with the correct current one; new works, old fails", async () => {
    const { user } = await adminUser();
    const res = await req({
      method: "POST", url: "/api/auth/change-password", cookies: sessionFor(user.id),
      payload: { currentPassword: PW, newPassword: "BrandNew-pw-99999999" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const withNew = await req({ method: "POST", url: "/api/auth/login", payload: { email: "admin@t.co", password: "BrandNew-pw-99999999" } });
    expect(withNew.statusCode).toBe(200);
    const withOld = await req({ method: "POST", url: "/api/auth/login", payload: { email: "admin@t.co", password: PW } });
    expect(withOld.statusCode).toBe(401);
  });

  it("rejects a wrong current password (400) and does not change anything", async () => {
    const { user } = await adminUser();
    const res = await req({
      method: "POST", url: "/api/auth/change-password", cookies: sessionFor(user.id),
      payload: { currentPassword: "not-the-password", newPassword: "BrandNew-pw-99999999" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toHaveProperty("currentPassword");
    // original password still works
    expect((await req({ method: "POST", url: "/api/auth/login", payload: { email: "admin@t.co", password: PW } })).statusCode).toBe(200);
  });

  it("rejects a too-short new password (400)", async () => {
    const { user } = await adminUser();
    const res = await req({
      method: "POST", url: "/api/auth/change-password", cookies: sessionFor(user.id),
      payload: { currentPassword: PW, newPassword: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toHaveProperty("newPassword");
  });

  it("requires authentication (401)", async () => {
    const res = await req({ method: "POST", url: "/api/auth/change-password", payload: { currentPassword: PW, newPassword: "BrandNew-pw-99999999" } });
    expect(res.statusCode).toBe(401);
  });
});

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get("token") ?? "";
}

describe("forgot / reset password", () => {
  it("forgot-password always returns 200 (existence hiding) and emails a link for real users", async () => {
    const { user } = await adminUser();
    const real = await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    expect(real.statusCode).toBe(200);
    expect(lastReset?.to).toBe("admin@t.co");
    expect(tokenFromUrl(lastReset!.url).length).toBeGreaterThan(10);

    lastReset = null;
    const unknown = await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "nobody@t.co" } });
    expect(unknown.statusCode).toBe(200); // same response
    expect(lastReset).toBeNull(); // but no email sent
    expect(user).toBeTruthy();
  });

  it("resets the password with the emailed token; new works, old fails, token is single-use", async () => {
    await adminUser();
    await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    const token = tokenFromUrl(lastReset!.url);

    const reset = await req({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "Reset-pw-123456789" } });
    expect(reset.statusCode).toBe(200);

    expect((await req({ method: "POST", url: "/api/auth/login", payload: { email: "admin@t.co", password: "Reset-pw-123456789" } })).statusCode).toBe(200);
    expect((await req({ method: "POST", url: "/api/auth/login", payload: { email: "admin@t.co", password: PW } })).statusCode).toBe(401);

    // token cannot be reused
    expect((await req({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "Another-pw-123456789" } })).statusCode).toBe(400);
  });

  it("a completed reset invalidates existing sessions", async () => {
    const { user } = await adminUser();
    const oldCookie = sessionFor(user.id); // version 0
    expect((await req({ method: "GET", url: "/api/me", cookies: oldCookie })).statusCode).toBe(200);

    await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    await req({ method: "POST", url: "/api/auth/reset-password", payload: { token: tokenFromUrl(lastReset!.url), password: "Reset-pw-123456789" } });

    // old session cookie (stale sessionVersion) no longer authenticates
    expect((await req({ method: "GET", url: "/api/me", cookies: oldCookie })).statusCode).toBe(401);
  });

  it("rejects an invalid/expired token and a too-short password (400)", async () => {
    await adminUser();
    expect((await req({ method: "POST", url: "/api/auth/reset-password", payload: { token: "nope", password: "Reset-pw-123456789" } })).statusCode).toBe(400);
    await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    expect((await req({ method: "POST", url: "/api/auth/reset-password", payload: { token: tokenFromUrl(lastReset!.url), password: "short" } })).statusCode).toBe(400);
  });

  it("a new forgot-password request invalidates the previous link", async () => {
    await adminUser();
    await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    const firstToken = tokenFromUrl(lastReset!.url);
    await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    // the first token is now used/void
    expect((await req({ method: "POST", url: "/api/auth/reset-password", payload: { token: firstToken, password: "Reset-pw-123456789" } })).statusCode).toBe(400);
  });
});

describe("change password invalidates other sessions", () => {
  it("bumps sessionVersion so other existing cookies stop working", async () => {
    const { user } = await adminUser();
    const otherCookie = sessionFor(user.id); // version 0, e.g. another device
    await req({ method: "POST", url: "/api/auth/change-password", cookies: sessionFor(user.id), payload: { currentPassword: PW, newPassword: "Changed-pw-123456789" } });
    expect((await req({ method: "GET", url: "/api/me", cookies: otherCookie })).statusCode).toBe(401);
  });
});

describe("reset password hardening", () => {
  it("is single-use under concurrency: two resets with the same token → one 200, one 400", async () => {
    await adminUser();
    await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    const token = tokenFromUrl(lastReset!.url);
    const [a, b] = await Promise.all([
      req({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "Reset-pw-123456789" } }),
      req({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "Other-pw-123456789" } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
  });

  it("revokes the user's API tokens on reset (full logout)", async () => {
    const { user } = await adminUser();
    const raw = createRawToken();
    await prisma.apiToken.create({ data: { userId: user.id, name: "cli", tokenHash: hashToken(raw, env.tokenHashSecret) } });
    expect((await req({ method: "GET", url: "/api/me", headers: bearer(raw) })).statusCode).toBe(200);

    await req({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "admin@t.co" } });
    await req({ method: "POST", url: "/api/auth/reset-password", payload: { token: tokenFromUrl(lastReset!.url), password: "Reset-pw-123456789" } });

    expect((await req({ method: "GET", url: "/api/me", headers: bearer(raw) })).statusCode).toBe(401);
  });
});

describe("registration / email verification", () => {
  const registerPayload = (email: string, companyName: string, subdomain: string) => ({
    email,
    name: "New Person",
    password: "Signup-pw-123456789",
    companyName,
    subdomain,
  });

  it("registers a user, creates their workspace (admin), signs them in, and sends verification", async () => {
    const res = await req({ method: "POST", url: "/api/auth/register", payload: registerPayload("new@t.co", "New Company", "new-company") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emailVerified).toBe(false);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0].role).toBe("admin");
    expect(body.workspaces[0].name).toBe("New Company");
    expect(body.workspaces[0].subdomain).toBe("new-company");
    expect(res.cookies.find((c: { name: string }) => c.name === "pm_session")).toBeTruthy();
    expect(lastVerify?.to).toBe("new@t.co");
    // can log in with the new credentials
    expect((await req({ method: "POST", url: "/api/auth/login", payload: { email: "new@t.co", password: "Signup-pw-123456789" } })).statusCode).toBe(200);
  });

  it("rejects a duplicate email and invalid input (400)", async () => {
    await req({ method: "POST", url: "/api/auth/register", payload: registerPayload("dup@t.co", "Duplicate Company", "duplicate-company") });
    const dup = await req({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...registerPayload("dup@t.co", "Duplicate Company 2", "duplicate-company-2"), name: "Dup2" },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().fields).toHaveProperty("email");
    const bad = await req({ method: "POST", url: "/api/auth/register", payload: { email: "notanemail", name: "", password: "short" } });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().fields).sort()).toEqual(["companyName", "email", "name", "password", "subdomain"]);
  });

  it("verifies email with the emailed token (single-use) and flips /api/me", async () => {
    const reg = await req({ method: "POST", url: "/api/auth/register", payload: registerPayload("verify@t.co", "Verify Company", "verify-company") });
    const cookie = { pm_session: reg.cookies.find((c: { name: string; value: string }) => c.name === "pm_session")!.value };
    const token = new URL(lastVerify!.url).searchParams.get("token") ?? "";

    expect((await req({ method: "POST", url: "/api/auth/verify-email", payload: { token } })).statusCode).toBe(200);
    expect((await req({ method: "GET", url: "/api/me", cookies: cookie })).json().emailVerified).toBe(true);
    // token is single-use
    expect((await req({ method: "POST", url: "/api/auth/verify-email", payload: { token } })).statusCode).toBe(400);
  });

  it("rejects an invalid verification token (400)", async () => {
    expect((await req({ method: "POST", url: "/api/auth/verify-email", payload: { token: "nope" } })).statusCode).toBe(400);
  });

  it("rejects an expired verification token (400)", async () => {
    await req({ method: "POST", url: "/api/auth/register", payload: registerPayload("exp@t.co", "Expired Company", "expired-company") });
    const token = new URL(lastVerify!.url).searchParams.get("token") ?? "";
    await prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await req({ method: "POST", url: "/api/auth/verify-email", payload: { token } })).statusCode).toBe(400);
  });

  it("resend invalidates the previous verification link", async () => {
    const reg = await req({ method: "POST", url: "/api/auth/register", payload: registerPayload("rsd@t.co", "Resend One Company", "resend-one-company") });
    const cookie = { pm_session: reg.cookies.find((c: { name: string; value: string }) => c.name === "pm_session")!.value };
    const oldToken = new URL(lastVerify!.url).searchParams.get("token") ?? "";
    await req({ method: "POST", url: "/api/auth/resend-verification", cookies: cookie });
    expect((await req({ method: "POST", url: "/api/auth/verify-email", payload: { token: oldToken } })).statusCode).toBe(400);
  });

  it("resend-verification sends a fresh link for an unverified user and no-ops once verified", async () => {
    const reg = await req({ method: "POST", url: "/api/auth/register", payload: registerPayload("resend@t.co", "Resend Two Company", "resend-two-company") });
    const cookie = { pm_session: reg.cookies.find((c: { name: string; value: string }) => c.name === "pm_session")!.value };
    lastVerify = null;
    expect((await req({ method: "POST", url: "/api/auth/resend-verification", cookies: cookie })).statusCode).toBe(200);
    expect(lastVerify?.to).toBe("resend@t.co");
    // verify, then resend is a no-op (still 200, no new email)
    await req({ method: "POST", url: "/api/auth/verify-email", payload: { token: new URL(lastVerify!.url).searchParams.get("token") ?? "" } });
    lastVerify = null;
    expect((await req({ method: "POST", url: "/api/auth/resend-verification", cookies: cookie })).statusCode).toBe(200);
    expect(lastVerify).toBeNull();
  });
});
