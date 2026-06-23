import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { addMember, createUser, createWorkspace } from "../fixtures/seed.js";

beforeAll(async () => {
  await getApp();
});
afterAll(async () => {
  await closeApp();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

function basic(clientId: string, clientSecret: string) {
  return { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` };
}

function tokenFromConnectUrl(connectUrl: string): string {
  const parsed = new URL(connectUrl);
  const token = parsed.searchParams.get("token");
  if (!token) throw new Error(`connect URL did not contain token: ${connectUrl}`);
  return token;
}

async function setupWorkspace() {
  const workspace = await createWorkspace("Acme", `acme-${randomUUID().slice(0, 8)}`);
  const admin = await createUser(`admin-${randomUUID()}@t.co`, "Admin");
  await addMember(workspace.id, admin.id, "admin");
  return { workspace, admin, adminCookie: sessionFor(admin.id) };
}

async function createIntegration(scopes = ["connect:write", "links:read"]) {
  const setup = await setupWorkspace();
  const res = await req({
    method: "POST",
    url: `/api/workspaces/${setup.workspace.id}/integrations`,
    cookies: setup.adminCookie,
    payload: { providerKey: "openclaw", runtimeMode: "openresponses", name: "Acme OpenClaw", scopes },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { integration: { id: string; clientId: string; workspaceId: string; scopes: string[] }; clientSecret: string };
  return { ...setup, integration: body.integration, clientSecret: body.clientSecret, auth: basic(body.integration.clientId, body.clientSecret) };
}

async function createConnectSession(auth: Record<string, string>, externalAccountId = "discord-user-1") {
  const res = await req({
    method: "POST",
    url: "/api/integrations/connect-sessions",
    headers: auth,
    payload: { externalProvider: "discord", externalAccountId, externalUsername: "chris" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { sessionId: string; connectUrl: string; expiresAt: string };
}

async function confirm(sessionId: string, token: string, userId: string) {
  return req({
    method: "POST",
    url: `/api/integrations/connect-sessions/${sessionId}/confirm`,
    cookies: sessionFor(userId),
    payload: { token },
  });
}

describe("REST-mode external integration account linking", () => {
  it("lets workspace admins create, list, rotate, and revoke integration credentials", async () => {
    const { workspace, adminCookie, integration, clientSecret } = await createIntegration(["connect:write", "links:read"]);
    expect(integration.clientId.startsWith("pd_int_")).toBe(true);
    expect(clientSecret.startsWith("pd_secret_")).toBe(true);

    const stored = await prisma.workspaceIntegration.findUniqueOrThrow({ where: { id: integration.id } });
    expect(stored.clientSecretHash).not.toBe(clientSecret);
    expect(stored.clientSecretHash).toMatch(/^[a-f0-9]{64}$/);

    const list = await req({ method: "GET", url: `/api/workspaces/${workspace.id}/integrations`, cookies: adminCookie });
    expect(list.statusCode).toBe(200);
    expect(list.json().integrations).toHaveLength(1);
    expect(list.json().integrations[0].clientSecretHash).toBeUndefined();

    const rotated = await req({ method: "POST", url: `/api/workspaces/${workspace.id}/integrations/${integration.id}/rotate-secret`, cookies: adminCookie });
    expect(rotated.statusCode).toBe(200);
    const newSecret = rotated.json().clientSecret as string;
    expect(newSecret).not.toBe(clientSecret);

    const oldAuth = await req({
      method: "GET",
      url: "/api/integrations/link-status?externalProvider=discord&externalAccountId=nope",
      headers: basic(integration.clientId, clientSecret),
    });
    expect(oldAuth.statusCode).toBe(401);

    const revoke = await req({ method: "DELETE", url: `/api/workspaces/${workspace.id}/integrations/${integration.id}`, cookies: adminCookie });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().integration.revokedAt).toEqual(expect.any(String));
  });

  it("rejects non-admin integration management", async () => {
    const workspace = await createWorkspace("Acme", "acme");
    const member = await createUser("member@t.co");
    await addMember(workspace.id, member.id, "member");
    const res = await req({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/integrations`,
      cookies: sessionFor(member.id),
      payload: { providerKey: "openclaw", name: "OpenClaw" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("enforces integration scopes on connect session and link-status endpoints", async () => {
    const connectOnly = await createIntegration(["connect:write"]);
    const created = await createConnectSession(connectOnly.auth, "scope-user");
    expect(created.sessionId).toEqual(expect.any(String));
    const statusForbidden = await req({
      method: "GET",
      url: "/api/integrations/link-status?externalProvider=discord&externalAccountId=scope-user",
      headers: connectOnly.auth,
    });
    expect(statusForbidden.statusCode).toBe(403);

    const readOnly = await createIntegration(["links:read"]);
    const createForbidden = await req({
      method: "POST",
      url: "/api/integrations/connect-sessions",
      headers: readOnly.auth,
      payload: { externalProvider: "discord", externalAccountId: "scope-user" },
    });
    expect(createForbidden.statusCode).toBe(403);
  });

  it("creates a hashed, short-lived connect session scoped to the authenticated integration", async () => {
    const { auth, integration, workspace } = await createIntegration();
    const created = await createConnectSession(auth);
    const rawToken = tokenFromConnectUrl(created.connectUrl);
    expect(rawToken.startsWith("pd_connect_")).toBe(true);
    expect(created.connectUrl).toContain("/integrations/connect");

    const stored = await prisma.externalConnectSession.findUniqueOrThrow({ where: { id: created.sessionId } });
    expect(stored.workspaceId).toBe(workspace.id);
    expect(stored.integrationId).toBe(integration.id);
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(stored.usedAt).toBeNull();
  });

  it("confirms a connect session only for workspace members and exposes scoped link status", async () => {
    const { auth, workspace, integration } = await createIntegration();
    const linkedUser = await createUser("linked@t.co");
    await addMember(workspace.id, linkedUser.id, "member");
    const outsider = await createUser("outsider@t.co");
    const outsiderSession = await createConnectSession(auth, "outsider");
    const outsiderRes = await confirm(outsiderSession.sessionId, tokenFromConnectUrl(outsiderSession.connectUrl), outsider.id);
    expect(outsiderRes.statusCode).toBe(403);

    const created = await createConnectSession(auth);
    const res = await confirm(created.sessionId, tokenFromConnectUrl(created.connectUrl), linkedUser.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().link.externalProvider).toBe("discord");
    expect(res.json().link.externalAccountId).toBe("discord-user-1");

    const status = await req({
      method: "GET",
      url: "/api/integrations/link-status?externalProvider=discord&externalAccountId=discord-user-1",
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().linked).toBe(true);
    expect(status.json().link.userId).toBeUndefined();

    const link = await prisma.externalAccountLink.findUniqueOrThrow({
      where: {
        integrationId_externalProvider_externalAccountId: {
          integrationId: integration.id,
          externalProvider: "discord",
          externalAccountId: "discord-user-1",
        },
      },
    });
    expect(link.workspaceId).toBe(workspace.id);
    expect(link.userId).toBe(linkedUser.id);
    expect(link.lastUsedAt).toBeInstanceOf(Date);
  });

  it("supports the browser GET confirmation flow with no-referrer", async () => {
    const { auth, workspace } = await createIntegration();
    const user = await createUser("browser@t.co");
    await addMember(workspace.id, user.id, "member");
    const created = await createConnectSession(auth, "browser-user");
    const rawToken = tokenFromConnectUrl(created.connectUrl);

    const page = await req({ method: "GET", url: `/integrations/connect?token=${encodeURIComponent(rawToken)}`, cookies: sessionFor(user.id) });
    expect(page.statusCode).toBe(200);
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body).toContain(`/api/integrations/connect-sessions/${created.sessionId}/confirm`);

    const confirmRes = await req({
      method: "GET",
      url: `/api/integrations/connect-sessions/${created.sessionId}/confirm?token=${encodeURIComponent(rawToken)}`,
      cookies: sessionFor(user.id),
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.body).toContain("Integration connected");
  });

  it("rejects expired, already-used, and conflicting connect sessions", async () => {
    const { auth, workspace, integration } = await createIntegration();
    const first = await createUser("first@t.co");
    const second = await createUser("second@t.co");
    await addMember(workspace.id, first.id, "member");
    await addMember(workspace.id, second.id, "member");

    const expired = await createConnectSession(auth, "expired-user");
    await prisma.externalConnectSession.update({ where: { id: expired.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await confirm(expired.sessionId, tokenFromConnectUrl(expired.connectUrl), first.id)).statusCode).toBe(404);

    const used = await createConnectSession(auth, "used-user");
    const usedToken = tokenFromConnectUrl(used.connectUrl);
    expect((await confirm(used.sessionId, usedToken, first.id)).statusCode).toBe(200);
    expect((await confirm(used.sessionId, usedToken, first.id)).statusCode).toBe(404);

    const original = await createConnectSession(auth, "same-platform-user");
    expect((await confirm(original.sessionId, tokenFromConnectUrl(original.connectUrl), first.id)).statusCode).toBe(200);
    const takeover = await createConnectSession(auth, "same-platform-user");
    const res = await confirm(takeover.sessionId, tokenFromConnectUrl(takeover.connectUrl), second.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_linked");

    const link = await prisma.externalAccountLink.findUniqueOrThrow({
      where: {
        integrationId_externalProvider_externalAccountId: {
          integrationId: integration.id,
          externalProvider: "discord",
          externalAccountId: "same-platform-user",
        },
      },
    });
    expect(link.userId).toBe(first.id);
  });

  it("scopes the same external account separately per integration", async () => {
    const one = await createIntegration();
    const two = await createIntegration();
    const userOne = await createUser("one@t.co");
    const userTwo = await createUser("two@t.co");
    await addMember(one.workspace.id, userOne.id, "member");
    await addMember(two.workspace.id, userTwo.id, "member");

    const first = await createConnectSession(one.auth, "same-discord");
    const second = await createConnectSession(two.auth, "same-discord");
    expect((await confirm(first.sessionId, tokenFromConnectUrl(first.connectUrl), userOne.id)).statusCode).toBe(200);
    expect((await confirm(second.sessionId, tokenFromConnectUrl(second.connectUrl), userTwo.id)).statusCode).toBe(200);

    const statusOne = await req({
      method: "GET",
      url: "/api/integrations/link-status?externalProvider=discord&externalAccountId=same-discord",
      headers: one.auth,
    });
    const statusTwo = await req({
      method: "GET",
      url: "/api/integrations/link-status?externalProvider=discord&externalAccountId=same-discord",
      headers: two.auth,
    });
    expect(statusOne.statusCode).toBe(200);
    expect(statusTwo.statusCode).toBe(200);
    expect(statusOne.json().link.integrationId).not.toBe(statusTwo.json().link.integrationId);
  });

  it("lets the linked user list and revoke external account links", async () => {
    const { auth, workspace } = await createIntegration();
    const user = await createUser("unlink@t.co");
    await addMember(workspace.id, user.id, "member");
    const created = await createConnectSession(auth, "unlink-user");
    await confirm(created.sessionId, tokenFromConnectUrl(created.connectUrl), user.id);

    const list = await req({ method: "GET", url: "/api/me/external-links", cookies: sessionFor(user.id) });
    expect(list.statusCode).toBe(200);
    expect(list.json().links).toHaveLength(1);
    expect(list.json().links[0].workspace.name).toBe("Acme");
    expect(list.json().links[0].integration.providerKey).toBe("openclaw");

    const linkId = list.json().links[0].id as string;
    const revoke = await req({ method: "DELETE", url: `/api/me/external-links/${linkId}`, cookies: sessionFor(user.id) });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().link.revokedAt).toEqual(expect.any(String));

    const status = await req({
      method: "GET",
      url: "/api/integrations/link-status?externalProvider=discord&externalAccountId=unlink-user",
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().linked).toBe(false);
  });
});
