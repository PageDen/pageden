import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { addMember, baseScenario, createUser, createWorkspace } from "../fixtures/seed.js";
import { drainScanWorker, setScanner } from "../../src/attachments/scanner.js";
import { registerServerAnalyticsListener, type ServerEventPayload } from "../../src/lib/analytics-bus.js";

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

// ---------------------------------------------------------------------------
// Shared helper for Phase 2 + Phase 5 tests
// ---------------------------------------------------------------------------

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
    payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1" },
  });
  expect(sRes.statusCode).toBe(201);
  const { sessionId, connectUrl } = sRes.json() as { sessionId: string; connectUrl: string };
  await confirm(sessionId, tokenFromConnectUrl(connectUrl), s.admin.id);

  return { s, auth };
}

// ---------------------------------------------------------------------------
// Phase 2 — REST action endpoints
// ---------------------------------------------------------------------------

describe("REST-mode document action endpoints", () => {
  it("document-read: 403 account_not_linked with connectUrl for unknown external account", async () => {
    const { s, auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "nobody", documentId: s.docId },
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
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId },
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
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: "does-not-exist" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("document-read: 400 when both documentId and path are missing", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-read: 200 workspace-level read (no externalAccountId) for canonical doc", async () => {
    const { s, auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { documentId: s.docId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.id).toBe(s.docId);
  });

  it("document-read: 403 when integration lacks documents:read scope", async () => {
    const { auth } = await createIntegration(["connect:write", "links:read"]);
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: "any" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("document-search: 403 account_not_linked with connectUrl for unknown external account", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "nobody", query: "runbook" },
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
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", query: "Runbook" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toBeInstanceOf(Array);
    expect(res.json().results[0]).toHaveProperty("workspaceId");
  });

  it("document-search: 200 fans out across all user workspaces when user is a member of multiple", async () => {
    const { s, auth } = await setupActions();

    // Add the same user to a second workspace with its own document
    const ws2 = await createWorkspace("Second Workspace", `ws2-${randomUUID().slice(0, 8)}`);
    await addMember(ws2.id, s.admin.id, "admin");
    const f2 = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: ws2.id, name: "Ops", slug: "ops" },
    });
    expect(f2.statusCode).toBe(201);
    const d2 = await req({
      method: "POST",
      url: "/api/documents",
      cookies: s.adminCookie,
      payload: { workspaceId: ws2.id, folderId: f2.json().id, title: "Runbook 2", slug: "runbook-2", content: "# Runbook 2\n" },
    });
    expect(d2.statusCode).toBe(201);

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", query: "Runbook" },
    });
    expect(res.statusCode).toBe(200);
    const { results, errors } = res.json() as { results: Array<{ workspaceId: string }>; errors?: unknown[] };
    expect(results).toBeInstanceOf(Array);
    expect(errors ?? []).toHaveLength(0);
    const wsIds = new Set(results.map((r) => r.workspaceId));
    expect(wsIds.has(s.ws.id)).toBe(true);
    expect(wsIds.has(ws2.id)).toBe(true);
  });

  it("document-search: 400 when query is missing", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-search: 403 when integration lacks documents:read scope", async () => {
    const { auth } = await createIntegration(["connect:write", "links:read"]);
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", query: "test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("list-workspaces: 200 returns workspaces the linked user belongs to", async () => {
    const { s, auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/list-workspaces",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1" },
    });
    expect(res.statusCode).toBe(200);
    const workspaces = res.json().workspaces as Array<{ id: string; name: string; slug: string; role: string }>;
    expect(workspaces.length).toBeGreaterThan(0);
    expect(workspaces.some((w) => w.id === s.ws.id)).toBe(true);
    expect(workspaces[0].name).toBeDefined();
    expect(workspaces[0].role).toBeDefined();
  });

  it("list-workspaces: 403 account_not_linked for unknown external account", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/list-workspaces",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "nobody" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("account_not_linked");
  });

  it("list-workspaces: 400 when externalAccountId is missing", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/list-workspaces",
      headers: auth,
      payload: { externalProvider: "hermes" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Write action endpoints (document-create / append / update / file-attach)
// ---------------------------------------------------------------------------

async function setupWriteActions() {
  const s = await baseScenario();
  const iRes = await req({
    method: "POST",
    url: `/api/workspaces/${s.ws.id}/integrations`,
    cookies: s.adminCookie,
    payload: { providerKey: "hermes", runtimeMode: "rest", name: "Hermes", scopes: ["connect:write", "links:read", "documents:read", "documents:write"] },
  });
  expect(iRes.statusCode).toBe(201);
  const { integration, clientSecret } = iRes.json() as { integration: { id: string; clientId: string }; clientSecret: string };
  const auth = basic(integration.clientId, clientSecret);

  const sRes = await req({
    method: "POST",
    url: "/api/integrations/connect-sessions",
    headers: auth,
    payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1" },
  });
  expect(sRes.statusCode).toBe(201);
  const { sessionId, connectUrl } = sRes.json() as { sessionId: string; connectUrl: string };
  await confirm(sessionId, tokenFromConnectUrl(connectUrl), s.admin.id);

  return { s, auth };
}

describe("REST-mode write action endpoints", () => {
  it("document-create: 403 when integration lacks documents:write scope", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalAccountId: "hermes-admin-1", path: "/engineering/test-doc", title: "Test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("document-create: 400 when externalAccountId is missing", async () => {
    const { auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { path: "/engineering/test-doc", title: "Test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-create: 400 when path has invalid slug", async () => {
    const { auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", path: "/engineering/My Doc", title: "My Doc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-create: 404 when folder does not exist", async () => {
    const { auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", path: "/no-such-folder/test-doc", title: "Test" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("document-create: 201 creates a new document", async () => {
    const { auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: {
        externalProvider: "hermes",
        externalAccountId: "hermes-admin-1",
        path: "/engineering/new-runbook",
        title: "New Runbook",
        content: "# New Runbook\n\nContent here.",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.document.title).toBe("New Runbook");
    expect(body.document.path).toBe("engineering/new-runbook.md");
  });

  it("document-create: 409 when slug already taken in folder", async () => {
    const { auth } = await setupWriteActions();
    const payload = {
      externalProvider: "hermes",
      externalAccountId: "hermes-admin-1",
      path: "/engineering/runbook",
      title: "Duplicate",
    };
    const res = await req({ method: "POST", url: "/api/integrations/actions/document-create", headers: auth, payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("conflict");
  });

  it("document-append: 200 appends content to existing document", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-append",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId, content: "\n## Appended Section\n\nNew content." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.id).toBe(s.docId);
  });

  it("document-append: 400 when content is missing", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-append",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-append: 404 when document does not exist", async () => {
    const { auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-append",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: "nonexistent-id", content: "hello" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("document-update: 200 replaces document content", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-update",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId, content: "# Updated\n\nNew body.", title: "Updated Runbook" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.id).toBe(s.docId);
  });

  it("document-update: 400 when neither content nor title provided", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-update",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("file-attach: 400 when fileUrl is missing", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/file-attach",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("file-attach: 400 when fileUrl is unreachable", async () => {
    const { s, auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/file-attach",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId, fileUrl: "http://127.0.0.1:19999/no-such-file.txt" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("document-search: 200 workspace-level search (no externalAccountId)", async () => {
    const { auth } = await setupWriteActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-search",
      headers: auth,
      payload: { query: "Runbook" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toBeInstanceOf(Array);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — Hosted integration MCP endpoint
// ---------------------------------------------------------------------------

describe("hosted integration MCP endpoint (POST /integrations/mcp)", () => {
  function mcpCall(method: string, params?: unknown) {
    return { jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) };
  }

  it("401 for missing or invalid credentials", async () => {
    const res = await req({ method: "POST", url: "/integrations/mcp", payload: mcpCall("initialize") });
    expect(res.statusCode).toBe(401);
  });

  it("initialize returns protocolVersion and serverInfo", async () => {
    const { auth } = await setupActions();
    const res = await req({ method: "POST", url: "/integrations/mcp", headers: auth, payload: mcpCall("initialize") });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.protocolVersion).toBe("2024-11-05");
    expect(res.json().result.serverInfo.name).toBe("pageden-integration");
  });

  it("tools/list returns pageden_read_document and pageden_search_documents", async () => {
    const { auth } = await setupActions();
    const res = await req({ method: "POST", url: "/integrations/mcp", headers: auth, payload: mcpCall("tools/list") });
    expect(res.statusCode).toBe(200);
    const names = (res.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("pageden_read_document");
    expect(names).toContain("pageden_search_documents");
  });

  it("notifications get 202 no-content", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/integrations/mcp",
      headers: auth,
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(res.statusCode).toBe(202);
  });

  it("tools/call pageden_read_document returns document content for linked user", async () => {
    const { s, auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/integrations/mcp",
      headers: auth,
      payload: mcpCall("tools/call", {
        name: "pageden_read_document",
        arguments: { externalAccountId: "hermes-admin-1", documentId: s.docId },
      }),
    });
    expect(res.statusCode).toBe(200);
    const text = (res.json().result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text) as { id: string; content: string };
    expect(parsed.id).toBe(s.docId);
    expect(parsed.content).toContain("# Runbook");
  });

  it("tools/call pageden_read_document returns connect URL for unlinked account", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/integrations/mcp",
      headers: auth,
      payload: mcpCall("tools/call", {
        name: "pageden_read_document",
        arguments: { externalAccountId: "nobody", documentId: "any" },
      }),
    });
    expect(res.statusCode).toBe(200);
    const text = (res.json().result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/integrations\/connect\?token=/);
  });

  it("tools/call pageden_search_documents returns results for linked user", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/integrations/mcp",
      headers: auth,
      payload: mcpCall("tools/call", {
        name: "pageden_search_documents",
        arguments: { externalAccountId: "hermes-admin-1", query: "Runbook" },
      }),
    });
    expect(res.statusCode).toBe(200);
    const text = (res.json().result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text) as { results: unknown[] };
    expect(parsed.results).toBeInstanceOf(Array);
  });

  it("tools/call returns scope error message when integration lacks documents:read", async () => {
    const { auth } = await createIntegration(["connect:write", "links:read"]);
    const res = await req({
      method: "POST",
      url: "/integrations/mcp",
      headers: auth,
      payload: mcpCall("tools/call", {
        name: "pageden_read_document",
        arguments: { externalAccountId: "hermes-admin-1", documentId: "any" },
      }),
    });
    expect(res.statusCode).toBe(200);
    const text = (res.json().result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("documents:read");
  });

  it("batch requests return an array of responses", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/integrations/mcp",
      headers: auth,
      payload: [mcpCall("initialize"), mcpCall("tools/list")],
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect((res.json() as unknown[]).length).toBe(2);
  });

  it("unknown method returns -32601 error", async () => {
    const { auth } = await setupActions();
    const res = await req({ method: "POST", url: "/integrations/mcp", headers: auth, payload: mcpCall("unknown/method") });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe(-32601);
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

describe("REST-mode attachment-read action endpoint", () => {
  it("400 when attachmentId is missing", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_request");
  });

  it("400 when externalAccountId is missing", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", attachmentId: "some-id" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_request");
  });

  it("403 account_not_linked for unknown external account", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "nobody", attachmentId: "some-id" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("account_not_linked");
    expect(res.json().connectUrl).toMatch(/\/integrations\/connect\?token=/);
  });

  it("404 when attachment does not exist", async () => {
    const { auth } = await setupActions();
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", attachmentId: "nonexistent-id" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("200 returns base64 bytes and metadata for a ready attachment", async () => {
    const { s, auth } = await setupActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "diagram.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    const attachmentId = up.json().id as string;
    await drainScanWorker();

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", attachmentId },
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

    const { s, auth } = await setupActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "scan.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    const attachmentId = up.json().id as string;

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", attachmentId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("scan_pending");

    // Unblock scanner so the worker finishes before the next test calls drainScanWorker
    unblock();
    await drainScanWorker();
  });

  it("403 when attachment is QUARANTINED", async () => {
    const { s, auth } = await setupActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "bad.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    const attachmentId = up.json().id as string;
    await prisma.attachment.update({ where: { id: attachmentId }, data: { status: "QUARANTINED" } });

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", attachmentId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("404 when attachment belongs to a different workspace", async () => {
    const ws1 = await setupActions();
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
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", attachmentId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("403 when integration lacks documents:read scope", async () => {
    const { auth } = await createIntegration(["connect:write", "links:read"]);
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/attachment-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", attachmentId: "any" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("document-read includes attachments list", async () => {
    const { s, auth } = await setupActions();
    const up = await uploadAttachment(s.docId, s.adminCookie, "chart.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    await drainScanWorker();

    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId },
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

// ---------------------------------------------------------------------------
// Agent analytics for REST (Hermes) write actions — these were previously
// uninstrumented, so integration-driven uploads never surfaced as agent
// activity. They must emit the same agent_* events the MCP path does,
// attributed to the linked human user (not the integration).
// ---------------------------------------------------------------------------

describe("REST agent write actions emit agent analytics (attributed to linked user)", () => {
  let events: Array<{ event: string; payload: ServerEventPayload }> = [];

  beforeEach(() => {
    events = [];
    registerServerAnalyticsListener({
      track(event, payload) {
        events.push({ event, payload });
      },
      identify() {},
    });
  });
  afterEach(() => registerServerAnalyticsListener(null));

  it("document-create emits agent_mcp_call + agent_document_created for the linked user", async () => {
    const { s, auth } = await setupWriteActions();
    events = [];
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-create",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", path: "/engineering/agent-note", title: "Agent Note", content: "# Hi\n" },
    });
    expect(res.statusCode).toBe(200);
    const created = events.find((e) => e.event === "agent_document_created");
    expect(created).toBeTruthy();
    expect(created!.payload.workspaceId).toBe(s.ws.id);
    expect(created!.payload.actor).toEqual({ userId: s.admin.id, tokenId: null });
    expect(created!.payload.properties).toMatchObject({ change_source: "agent", surface: "integration_rest" });
    expect(events.map((e) => e.event)).toContain("agent_mcp_call");
  });

  it("document-append emits agent_document_saved for the linked user", async () => {
    const { s, auth } = await setupWriteActions();
    events = [];
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-append",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId, content: "appended line" },
    });
    expect(res.statusCode).toBe(200);
    const saved = events.find((e) => e.event === "agent_document_saved");
    expect(saved).toBeTruthy();
    expect(saved!.payload.actor).toEqual({ userId: s.admin.id, tokenId: null });
    expect(saved!.payload.properties).toMatchObject({ doc_id: s.docId, change_source: "agent", surface: "integration_rest" });
  });

  it("document-read (per-user) emits agent_mcp_call + agent_document_read; workspace-level read does not", async () => {
    const { s, auth } = await setupActions();

    // Per-user read → agent events attributed to the linked user.
    events = [];
    const res = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { externalProvider: "hermes", externalAccountId: "hermes-admin-1", documentId: s.docId },
    });
    expect(res.statusCode).toBe(200);
    const read = events.find((e) => e.event === "agent_document_read");
    expect(read).toBeTruthy();
    expect(read!.payload.actor).toEqual({ userId: s.admin.id, tokenId: null });
    expect(read!.payload.properties).toMatchObject({ doc_id: s.docId, surface: "integration_rest" });
    expect(events.map((e) => e.event)).toContain("agent_mcp_call");

    // Workspace-level read (no externalAccountId) has no human to attribute → no agent events.
    events = [];
    const wsRead = await req({
      method: "POST",
      url: "/api/integrations/actions/document-read",
      headers: auth,
      payload: { documentId: s.docId },
    });
    expect(wsRead.statusCode).toBe(200);
    expect(events.map((e) => e.event)).not.toContain("agent_document_read");
    expect(events.map((e) => e.event)).not.toContain("agent_mcp_call");
  });
});
