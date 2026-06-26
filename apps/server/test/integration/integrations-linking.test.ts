import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { addMember, baseScenario, createUser, createWorkspace } from "../fixtures/seed.js";
import { drainScanWorker, setScanner } from "../../src/attachments/scanner.js";

beforeAll(async () => {
  await getApp();
});
afterAll(async () => {
  await closeApp();
  await prisma.$disconnect();
});
afterEach(() => {
  setScanner(undefined);
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

describe("REST-mode document action endpoints", () => {
  async function setupActions() {
    const s = await baseScenario();
    const iRes = await req({
      method: "POST",
      url: `/api/workspaces/${s.ws.id}/integrations`,
      cookies: s.adminCookie,
      payload: { providerKey: "hermes", runtimeMode: "rest", name: "Hermes", scopes: ["connect:write", "links:read", "documents:read"] },
    });
    expect(iRes.statusCode).toBe(201);
    const { integration, clientSecret } = iRes.json() as { integration: { id: string; clientId: string }; clientSecret: string };
    const auth = basic(integration.clientId, clientSecret);

    const sRes = await req({
      method: "POST",
      url: "/api/integrations/connect-sessions",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1" },
    });
    expect(sRes.statusCode).toBe(201);
    const { sessionId, connectUrl } = sRes.json() as { sessionId: string; connectUrl: string };
    await confirm(sessionId, tokenFromConnectUrl(connectUrl), s.admin.id);

    return { s, auth };
  }

  it("document-read: 403 account_not_linked with connectUrl for unknown external account", async () => {
    const { s, auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "nobody", documentId: s.docId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("account_not_linked");
    expect(res.json().connectUrl).toMatch(/\/integrations\/connect\?token=/);
  });

  it("document-read: 200 with document content for linked user with access", async () => {
    const { s, auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.id).toBe(s.docId);
    expect(res.json().document.content).toContain("# Runbook");
  });

  it("document-read: 404 when document does not exist", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: "does-not-exist" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("document-read: 400 when both documentId and path are missing", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-read: 400 when externalProvider or externalAccountId is missing", async () => {
    const { s, auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { documentId: s.docId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-read: 403 when integration lacks documents:read scope", async () => {
    const { auth } = await createIntegration(["connect:write", "links:read"]);
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: "any" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("document-search: 403 account_not_linked with connectUrl for unknown external account", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "nobody", query: "runbook" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("account_not_linked");
    expect(res.json().connectUrl).toMatch(/\/integrations\/connect\?token=/);
  });

  it("document-search: 200 with results for linked user", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", query: "Runbook" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toBeInstanceOf(Array);
  });

  it("document-search: 400 when query is missing", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-search: 403 when integration lacks documents:read scope", async () => {
    const { auth } = await createIntegration(["connect:write", "links:read"]);
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", query: "test" },
    });
    expect(res.statusCode).toBe(403);
  });
});

async function setupWriteActions() {
  const s = await baseScenario();
  const iRes = await req({
    method: "POST",
    url: `/api/workspaces/${s.ws.id}/integrations`,
    cookies: s.adminCookie,
    payload: {
      providerKey: "hermes",
      runtimeMode: "rest",
      name: "Hermes",
      scopes: ["connect:write", "links:read", "documents:read", "documents:write"],
    },
  });
  expect(iRes.statusCode).toBe(201);
  const { integration, clientSecret } = iRes.json() as { integration: { id: string; clientId: string }; clientSecret: string };
  const auth = basic(integration.clientId, clientSecret);

  const sRes = await req({
    method: "POST",
    url: "/api/integrations/connect-sessions",
    headers: auth,
    payload: { externalProvider: "discord", externalAccountId: "discord-admin-1" },
  });
  expect(sRes.statusCode).toBe(201);
  const { sessionId, connectUrl } = sRes.json() as { sessionId: string; connectUrl: string };
  const confirmed = await confirm(sessionId, tokenFromConnectUrl(connectUrl), s.admin.id);
  expect(confirmed.statusCode).toBe(200);

  return { s, auth };
}

describe("REST-mode write action endpoints", () => {
  it("document-create: 403 when integration lacks documents:write scope", async () => {
    const { auth } = await createIntegration(["connect:write", "links:read", "documents:read"]);
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", path: "/engineering/test-doc", title: "Test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("document-create: validates linked user and path before creating", async () => {
    const { auth } = await setupWriteActions();

    const missingAccount = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "discord", path: "/engineering/test-doc", title: "Test" },
    });
    expect(missingAccount.statusCode).toBe(400);

    const invalidPath = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", path: "/engineering/My Doc", title: "My Doc" },
    });
    expect(invalidPath.statusCode).toBe(400);

    const missingFolder = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", path: "/missing/new-doc", title: "New Doc" },
    });
    expect(missingFolder.statusCode).toBe(404);
  });

  it("document-create: creates a document through the linked user's permissions", async () => {
    const { auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: {
        externalProvider: "discord",
        externalAccountId: "discord-admin-1",
        path: "/engineering/new-runbook",
        title: "New Runbook",
        content: "# New Runbook\n\nCreated through an integration.",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.title).toBe("New Runbook");
    expect(res.json().document.path).toBe("engineering/new-runbook.md");

    const duplicate = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", path: "/engineering/new-runbook", title: "Duplicate" },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("document-append: appends content to an existing document", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-append",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId, content: "## Appended Section\n\nNew content." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.id).toBe(s.docId);

    const updated = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId },
    });
    expect(updated.json().document.content).toContain("## Appended Section");
  });

  it("document-append: validates content and document lookup", async () => {
    const { s, auth } = await setupWriteActions();
    const missingContent = await req({
      method: "POST",
      url: "/api/integrations/actions/document-append",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId },
    });
    expect(missingContent.statusCode).toBe(400);

    const missingDoc = await req({
      method: "POST",
      url: "/api/integrations/actions/document-append",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: "missing", content: "hello" },
    });
    expect(missingDoc.statusCode).toBe(404);
  });

  it("document-update: updates content and title", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-update",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId, content: "# Updated\n\nNew body.", title: "Updated Runbook" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.id).toBe(s.docId);

    const updated = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId },
    });
    expect(updated.json().document.title).toBe("Updated Runbook");
    expect(updated.json().document.content).toContain("# Updated");
  });

  it("document-update: requires content or title", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-update",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("file-attach: accepts base64 content and creates a scanning attachment", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/file-attach",
      headers: auth,
      payload: {
        externalProvider: "discord",
        externalAccountId: "discord-admin-1",
        documentId: s.docId,
        filename: "evidence.pdf",
        fileContent: Buffer.from("%PDF-1.4\n%PageDen test\n").toString("base64"),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().attachment.filename).toBe("evidence.pdf");
    expect(res.json().attachment.status).toBe("scanning");
  });

  it("file-attach: validates missing file content and rejects URL-only uploads", async () => {
    const { s, auth } = await setupWriteActions();
    const missingFile = await req({
      method: "POST",
      url: "/api/integrations/actions/file-attach",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId },
    });
    expect(missingFile.statusCode).toBe(400);
    expect(missingFile.json().message).toContain("fileContent");

    const urlOnly = await req({
      method: "POST",
      url: "/api/integrations/actions/file-attach",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId, fileUrl: "http://127.0.0.1:19999/missing.pdf" },
    });
    expect(urlOnly.statusCode).toBe(400);
    expect(urlOnly.json().message).toContain("fileContent");
  });
});

// ---------------------------------------------------------------------------
// attachment-read action endpoint
// ---------------------------------------------------------------------------

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452deadbeef", "hex");

async function uploadAttachment(docId: string, adminCookie: Record<string, string>, filename: string, body: Buffer, contentType = "image/png") {
  return req({
    method: "POST",
    url: `/api/documents/${docId}/attachments?filename=${encodeURIComponent(filename)}`,
    headers: { "content-type": contentType },
    cookies: adminCookie,
    payload: body,
  });
}

async function setupAttachmentActions() {
  const s = await baseScenario();
  const iRes = await req({
    method: "POST",
    url: `/api/workspaces/${s.ws.id}/integrations`,
    cookies: s.adminCookie,
    payload: { providerKey: "discord", runtimeMode: "rest", name: "Hermes", scopes: ["connect:write", "links:read", "documents:read"] },
  });
  const { integration, clientSecret } = iRes.json() as { integration: { id: string; clientId: string }; clientSecret: string };
  const auth = { authorization: `Basic ${Buffer.from(`${integration.clientId}:${clientSecret}`).toString("base64")}` };

  const sRes = await req({
    method: "POST",
    url: "/api/integrations/connect-sessions",
    headers: auth,
    payload: { externalProvider: "discord", externalAccountId: "discord-admin-1" },
  });
  const { sessionId, connectUrl } = sRes.json() as { sessionId: string; connectUrl: string };
  const parsed = new URL(connectUrl);
  const token = parsed.searchParams.get("token")!;
  await req({
    method: "POST",
    url: `/api/integrations/connect-sessions/${sessionId}/confirm`,
    cookies: sessionFor(s.admin.id),
    payload: { token },
  });

  return { s, auth };
}

describe("REST-mode attachment-read action endpoint", () => {
  it("400 when attachmentId is missing", async () => {
    const { auth } = await setupAttachmentActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_request");
  });

  it("400 when externalAccountId is missing", async () => {
    const { auth } = await setupAttachmentActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "discord", attachmentId: "some-id" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_request");
  });

  it("403 account_not_linked for unknown external account", async () => {
    const { auth } = await setupAttachmentActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "nobody", attachmentId: "some-id" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("account_not_linked");
    expect(res.json().connectUrl).toMatch(/\/integrations\/connect\?token=/);
  });

  it("404 when attachment does not exist", async () => {
    const { auth } = await setupAttachmentActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", attachmentId: "nonexistent-id" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("200 returns base64 bytes and metadata for a ready attachment", async () => {
    const { s, auth } = await setupAttachmentActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "diagram.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    const attachmentId = up.json().id as string;
    await drainScanWorker();

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", attachmentId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attachment.id).toBe(attachmentId);
    expect(body.attachment.filename).toBe("diagram.png");
    expect(body.attachment.contentType).toBe("image/png");
    expect(body.attachment.size).toBe(PNG.length);
    expect(typeof body.attachment.sha256).toBe("string");
    expect(Buffer.from(body.attachment.contentBase64 as string, "base64").equals(PNG)).toBe(true);
  });

  it("503 when attachment is still in SCANNING state", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    setScanner(async () => { await blocked; return "clean"; });

    const { s, auth } = await setupAttachmentActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "scan.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    const attachmentId = up.json().id as string;

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", attachmentId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("scan_pending");

    // Unblock scanner so the worker finishes before the next test calls drainScanWorker
    unblock();
    await drainScanWorker();
  });

  it("403 when attachment is QUARANTINED", async () => {
    const { s, auth } = await setupAttachmentActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "bad.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    const attachmentId = up.json().id as string;
    await prisma.attachment.update({ where: { id: attachmentId }, data: { status: "QUARANTINED" } });

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", attachmentId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("404 when attachment belongs to a different workspace", async () => {
    const ws1 = await setupAttachmentActions();
    // Use createIntegration for ws2 — it creates a workspace with a UUID slug so there's no slug collision
    const ws2 = await createIntegration(["connect:write", "links:read", "documents:read", "documents:write"]);
    const f2 = await req({
      method: "POST",
      url: "/api/folders",
      cookies: ws2.adminCookie,
      payload: { workspaceId: ws2.workspace.id, name: "Engineering", slug: "engineering" },
    });
    expect(f2.statusCode).toBe(201);
    const d2 = await req({
      method: "POST",
      url: "/api/documents",
      cookies: ws2.adminCookie,
      payload: { workspaceId: ws2.workspace.id, folderId: f2.json().id as string, title: "Doc", slug: "doc", content: "# Doc" },
    });
    expect(d2.statusCode).toBe(201);
    const up = await uploadAttachment(d2.json().id as string, ws2.adminCookie, "secret.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    await drainScanWorker();
    const attachmentId = up.json().id as string;

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: ws1.auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", attachmentId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("document-read includes attachments list", async () => {
    const { s, auth } = await setupAttachmentActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "chart.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    await drainScanWorker();

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "discord", externalAccountId: "discord-admin-1", documentId: s.docId },
    });
    expect(res.statusCode).toBe(200);
    const attachments = res.json().document.attachments as Array<{ id: string; filename: string; contentType: string; size: number }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("chart.png");
    expect(attachments[0].contentType).toBe("image/png");
    expect(attachments[0].size).toBe(PNG.length);
    expect(typeof attachments[0].id).toBe("string");
  });
});
