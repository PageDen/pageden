import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function setup(scopes = ["search", "read", "create", "update", "append"]) {
  const s = await baseScenario();
  const tokenRes = await req({
    method: "POST",
    url: "/api/tokens",
    cookies: s.adminCookie,
    payload: { name: "Scoped agent", kind: "agent", workspaceId: s.ws.id, scopes },
  });
  if (tokenRes.statusCode !== 201) throw new Error(`token failed: ${tokenRes.body}`);
  const token = tokenRes.json().token as string;

  const otherFolder = await req({
    method: "POST",
    url: "/api/folders",
    cookies: s.adminCookie,
    payload: { workspaceId: s.ws.id, name: "Private", slug: "private" },
  });
  if (otherFolder.statusCode !== 201) throw new Error(`folder failed: ${otherFolder.body}`);
  const privateFolderId = otherFolder.json().id as string;

  const otherDoc = await req({
    method: "POST",
    url: "/api/documents",
    cookies: s.adminCookie,
    payload: { workspaceId: s.ws.id, folderId: privateFolderId, title: "Secret", slug: "secret", content: "# secret\n" },
  });
  if (otherDoc.statusCode !== 201) throw new Error(`doc failed: ${otherDoc.body}`);
  const privateDocId = otherDoc.json().id as string;
  const privateDocVersion = otherDoc.json().version as string;

  return { ...s, token, privateFolderId, privateDocId, privateDocVersion };
}

describe("agent edit scope (Phase C2)", () => {
  it("agents can write anywhere when scope is null (default behavior)", async () => {
    const s = await setup();
    // Update the doc inside s.folderId — admin's session works, agent has full scopes.
    const upd = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      headers: bearer(s.token),
      payload: { baseVersion: s.version, content: "# allowed\n" },
    });
    expect(upd.statusCode).toBe(200);
  });

  it("setting the scope to a folder blocks agent writes outside the subtree", async () => {
    const s = await setup();
    // Pin agent writes to s.folderId. The "private" folder is outside that scope.
    const set = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: s.folderId },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().agentEditScopeFolderId).toBe(s.folderId);

    // Agent token CAN write inside the scope (s.folderId/s.docId)
    const inside = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      headers: bearer(s.token),
      payload: { baseVersion: s.version, content: "# in scope\n" },
    });
    expect(inside.statusCode).toBe(200);

    // Agent token CANNOT write outside the scope
    const outside = await req({
      method: "PUT",
      url: `/api/documents/${s.privateDocId}`,
      headers: bearer(s.token),
      payload: { baseVersion: s.privateDocVersion, content: "# out of scope\n" },
    });
    expect(outside.statusCode).toBe(403);
  });

  it("agent reads are unaffected by the edit scope", async () => {
    const s = await setup();
    await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: s.folderId },
    });

    const readPrivate = await req({
      method: "GET",
      url: `/api/documents/${s.privateDocId}`,
      headers: bearer(s.token),
    });
    expect(readPrivate.statusCode).toBe(200);
  });

  it("scope applies to document deletes outside the subtree", async () => {
    const s = await setup();
    await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: s.folderId },
    });

    const del = await req({
      method: "DELETE",
      url: `/api/documents/${s.privateDocId}`,
      headers: bearer(s.token),
    });
    expect(del.statusCode).toBe(403);
  });

  it("scope applies to folder writes (creating children) outside the subtree", async () => {
    const s = await setup();
    await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: s.folderId },
    });

    // Try to create a folder under the private folder (outside scope) — should fail.
    const create = await req({
      method: "POST",
      url: "/api/folders",
      headers: bearer(s.token),
      payload: { workspaceId: s.ws.id, parentFolderId: s.privateFolderId, name: "Nope", slug: "nope" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("sessions (humans) are unaffected by the agent scope", async () => {
    const s = await setup();
    await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: s.folderId },
    });

    // Admin (session) can still write to the "private" folder unaffected.
    const upd = await req({
      method: "PUT",
      url: `/api/documents/${s.privateDocId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.privateDocVersion, content: "# admin override\n" },
    });
    expect(upd.statusCode).toBe(200);
  });

  it("clearing the scope (folderId: null) restores agent-writes-anywhere", async () => {
    const s = await setup();
    await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: s.folderId },
    });
    const clear = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().agentEditScopeFolderId).toBeNull();

    const outside = await req({
      method: "PUT",
      url: `/api/documents/${s.privateDocId}`,
      headers: bearer(s.token),
      payload: { baseVersion: s.privateDocVersion, content: "# allowed again\n" },
    });
    expect(outside.statusCode).toBe(200);
  });

  it("rejects scope updates referencing a folder in a different workspace", async () => {
    const s = await setup();
    const otherWs = await prisma.workspace.create({ data: { name: "Other", slug: "other" } });
    const otherFolder = await prisma.folder.create({
      data: {
        workspaceId: otherWs.id,
        name: "OtherRoot",
        slug: "other-root",
        path: "other-root",
        createdById: s.admin.id,
        updatedById: s.admin.id,
      },
    });
    const bad = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: otherFolder.id },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("non-admins cannot set the scope", async () => {
    const s = await setup();
    const member = await req({
      method: "POST",
      url: "/api/users",
      cookies: s.adminCookie,
      payload: {
        workspaceId: s.ws.id,
        email: "member@t.co",
        name: "Member",
        password: "ChangeMe-12345678",
        role: "member",
      },
    });
    expect(member.statusCode).toBe(201);
    const memberId = member.json().id as string;
    const { sealSession, SESSION_COOKIE } = await import("../../src/session.js");
    const { env } = await import("../../src/env.js");
    const cookie = { [SESSION_COOKIE]: sealSession(memberId, 0, env.sessionSecret) };

    const res = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: cookie,
      payload: { folderId: s.folderId },
    });
    expect(res.statusCode).toBe(404);
  });

  it("MCP pageden_workspace_summary surfaces the scope so agents can pre-flight", async () => {
    const s = await setup(["search", "read"]);
    await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/agent-edit-scope`,
      cookies: s.adminCookie,
      payload: { folderId: s.folderId },
    });
    const summary = await req({
      method: "POST",
      url: "/mcp",
      headers: bearer(s.token),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "pageden_workspace_summary", arguments: { workspaceId: s.ws.id } },
      },
    });
    expect(summary.statusCode).toBe(200);
    const body = JSON.parse(summary.json().result.content[0].text);
    expect(body.agentEditScope?.folderId).toBe(s.folderId);
    expect(typeof body.agentEditScope?.folderPath).toBe("string");
  });
});
