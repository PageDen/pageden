import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { createUser } from "../fixtures/seed.js";

const HERMES_SECRET = "test-hermes-service-secret";

beforeAll(async () => {
  process.env.HERMES_SERVICE_SECRET = HERMES_SECRET;
  await getApp();
});
afterAll(async () => {
  await closeApp();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

function hermesAuth() {
  return bearer(HERMES_SECRET);
}

function tokenFromConnectUrl(connectUrl: string): string {
  const parsed = new URL(connectUrl);
  const token = parsed.searchParams.get("token");
  if (!token) throw new Error(`connect URL did not contain token: ${connectUrl}`);
  return token;
}

async function createConnectSession(providerAccountId = "discord-user-1") {
  const res = await req({
    method: "POST",
    url: "/api/hermes/connect-sessions",
    headers: hermesAuth(),
    payload: { provider: "discord", providerAccountId, providerUsername: "chris" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { sessionId: string; connectUrl: string; expiresAt: string };
}

async function confirm(sessionId: string, token: string, userId: string) {
  return req({
    method: "POST",
    url: `/api/hermes/connect-sessions/${sessionId}/confirm`,
    cookies: sessionFor(userId),
    payload: { token },
  });
}

describe("Hermes platform account linking", () => {
  it("requires Hermes service auth to create connect sessions and check status", async () => {
    const missing = await req({
      method: "POST",
      url: "/api/hermes/connect-sessions",
      payload: { provider: "discord", providerAccountId: "u1" },
    });
    expect(missing.statusCode).toBe(401);

    const bad = await req({
      method: "GET",
      url: "/api/hermes/link-status?provider=discord&providerAccountId=u1",
      headers: bearer("wrong"),
    });
    expect(bad.statusCode).toBe(401);
  });

  it("creates a hashed, short-lived connect session", async () => {
    const created = await createConnectSession();
    expect(created.expiresAt).toEqual(expect.any(String));
    const rawToken = tokenFromConnectUrl(created.connectUrl);
    expect(rawToken.startsWith("pm_hermes_")).toBe(true);

    const stored = await prisma.hermesConnectSession.findUniqueOrThrow({ where: { id: created.sessionId } });
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(stored.usedAt).toBeNull();
  });

  it("confirms a connect session and exposes link status", async () => {
    const user = await createUser("hermes@t.co");
    const created = await createConnectSession();
    const rawToken = tokenFromConnectUrl(created.connectUrl);

    const res = await confirm(created.sessionId, rawToken, user.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().link.provider).toBe("discord");
    expect(res.json().link.providerAccountId).toBe("discord-user-1");

    const storedSession = await prisma.hermesConnectSession.findUniqueOrThrow({ where: { id: created.sessionId } });
    expect(storedSession.usedAt).toBeInstanceOf(Date);

    const status = await req({
      method: "GET",
      url: "/api/hermes/link-status?provider=discord&providerAccountId=discord-user-1",
      headers: hermesAuth(),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().linked).toBe(true);
    expect(status.json().link.userId).toBeUndefined();

    const link = await prisma.externalAccountLink.findUniqueOrThrow({
      where: { provider_providerAccountId: { provider: "discord", providerAccountId: "discord-user-1" } },
    });
    expect(link.userId).toBe(user.id);
    expect(link.lastUsedAt).toBeInstanceOf(Date);
  });

  it("supports the browser GET confirmation flow", async () => {
    const user = await createUser("browser@t.co");
    const created = await createConnectSession("browser-user");
    const rawToken = tokenFromConnectUrl(created.connectUrl);

    const page = await req({ method: "GET", url: `/hermes/connect?token=${encodeURIComponent(rawToken)}`, cookies: sessionFor(user.id) });
    expect(page.statusCode).toBe(200);
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body).toContain(`/api/hermes/connect-sessions/${created.sessionId}/confirm`);

    const confirmRes = await req({
      method: "GET",
      url: `/api/hermes/connect-sessions/${created.sessionId}/confirm?token=${encodeURIComponent(rawToken)}`,
      cookies: sessionFor(user.id),
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.body).toContain("Hermes connected");
  });

  it("rejects expired and already-used connect sessions", async () => {
    const user = await createUser("expired@t.co");
    const expired = await createConnectSession("expired-user");
    await prisma.hermesConnectSession.update({ where: { id: expired.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await confirm(expired.sessionId, tokenFromConnectUrl(expired.connectUrl), user.id)).statusCode).toBe(404);

    const used = await createConnectSession("used-user");
    const token = tokenFromConnectUrl(used.connectUrl);
    expect((await confirm(used.sessionId, token, user.id)).statusCode).toBe(200);
    expect((await confirm(used.sessionId, token, user.id)).statusCode).toBe(404);
  });

  it("does not let another PageDen user claim an actively linked platform account", async () => {
    const first = await createUser("first@t.co");
    const second = await createUser("second@t.co");

    const original = await createConnectSession("same-platform-user");
    expect((await confirm(original.sessionId, tokenFromConnectUrl(original.connectUrl), first.id)).statusCode).toBe(200);

    const takeover = await createConnectSession("same-platform-user");
    const res = await confirm(takeover.sessionId, tokenFromConnectUrl(takeover.connectUrl), second.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_linked");

    const link = await prisma.externalAccountLink.findUniqueOrThrow({
      where: { provider_providerAccountId: { provider: "discord", providerAccountId: "same-platform-user" } },
    });
    expect(link.userId).toBe(first.id);
  });

  it("lets the linked user list and revoke the external account link", async () => {
    const user = await createUser("unlink@t.co");
    const created = await createConnectSession("unlink-user");
    await confirm(created.sessionId, tokenFromConnectUrl(created.connectUrl), user.id);

    const list = await req({ method: "GET", url: "/api/me/external-links", cookies: sessionFor(user.id) });
    expect(list.statusCode).toBe(200);
    expect(list.json().links).toHaveLength(1);

    const linkId = list.json().links[0].id as string;
    const revoke = await req({ method: "DELETE", url: `/api/me/external-links/${linkId}`, cookies: sessionFor(user.id) });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().link.revokedAt).toEqual(expect.any(String));

    const status = await req({
      method: "GET",
      url: "/api/hermes/link-status?provider=discord&providerAccountId=unlink-user",
      headers: hermesAuth(),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().linked).toBe(false);
  });
});
