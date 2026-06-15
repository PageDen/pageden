import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, member } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function tool(token: string, name: string, args: Record<string, unknown>) {
  return req({
    method: "POST",
    url: "/mcp",
    headers: bearer(token),
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
}
function toolJson(response: Awaited<ReturnType<typeof tool>>) {
  return JSON.parse(response.json().result.content[0].text);
}

async function agentTokenFor(s: Awaited<ReturnType<typeof baseScenario>>, scopes: string[]) {
  const created = await req({
    method: "POST",
    url: "/api/tokens",
    cookies: s.adminCookie,
    payload: { name: "Collab agent", kind: "agent", workspaceId: s.ws.id, scopes },
  });
  expect(created.statusCode).toBe(201);
  return created.json().token as string;
}

describe("inline comments (REST)", () => {
  it("creates, lists open + resolved, resolves, and deletes comments", async () => {
    const s = await baseScenario();
    const create = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/comments`,
      cookies: s.adminCookie,
      payload: { body: "Blocking question: is the schema finalized?", sectionAnchor: "open-questions" },
    });
    expect(create.statusCode).toBe(201);
    const commentId = create.json().comment.id as string;

    const open = await req({ method: "GET", url: `/api/documents/${s.docId}/comments`, cookies: s.adminCookie });
    expect(open.json().comments).toHaveLength(1);

    const resolve = await req({ method: "POST", url: `/api/comments/${commentId}/resolve`, cookies: s.adminCookie });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().comment.resolvedAt).toBeTruthy();

    const onlyOpen = await req({ method: "GET", url: `/api/documents/${s.docId}/comments`, cookies: s.adminCookie });
    expect(onlyOpen.json().comments).toHaveLength(0);
    const withResolved = await req({
      method: "GET",
      url: `/api/documents/${s.docId}/comments?includeResolved=true`,
      cookies: s.adminCookie,
    });
    expect(withResolved.json().comments).toHaveLength(1);

    const del = await req({ method: "DELETE", url: `/api/comments/${commentId}`, cookies: s.adminCookie });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);
  });

  it("validates the body and 404s on missing documents", async () => {
    const s = await baseScenario();
    const empty = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/comments`,
      cookies: s.adminCookie,
      payload: { body: "   " },
    });
    expect(empty.statusCode).toBe(400);
    const missing = await req({
      method: "POST",
      url: `/api/documents/does-not-exist/comments`,
      cookies: s.adminCookie,
      payload: { body: "hi" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("forbids resolving someone else's comment unless you're a manager", async () => {
    const s = await baseScenario();
    const other = await member(s.ws.id, "viewer@t.co", "member");
    // Grant the other user viewer access to the document so they can read but not manage it.
    await prisma.permission.create({
      data: { workspaceId: s.ws.id, subjectType: "user", subjectId: other.user.id, resourceType: "document", resourceId: s.docId, role: "viewer" },
    });
    const create = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/comments`,
      cookies: other.cookie,
      payload: { body: "From the viewer" },
    });
    expect(create.statusCode).toBe(201);
    const commentId = create.json().comment.id as string;

    // Another viewer who is also a workspace member but not the author and not a manager can't resolve.
    const peer = await member(s.ws.id, "peer@t.co", "member");
    await prisma.permission.create({
      data: { workspaceId: s.ws.id, subjectType: "user", subjectId: peer.user.id, resourceType: "document", resourceId: s.docId, role: "viewer" },
    });
    const forbidden = await req({ method: "POST", url: `/api/comments/${commentId}/resolve`, cookies: peer.cookie });
    expect(forbidden.statusCode).toBe(403);
  });

  it("hides comments from non-members", async () => {
    const s = await baseScenario();
    await req({ method: "POST", url: `/api/documents/${s.docId}/comments`, cookies: s.adminCookie, payload: { body: "hi" } });
    const stranger = await createUser("stranger@t.co", "S");
    const res = await req({ method: "GET", url: `/api/documents/${s.docId}/comments`, cookies: sessionFor(stranger.id) });
    expect(res.statusCode).toBe(404);
  });
});

describe("read-tracking + my-unread MCP", () => {
  it("touches the cursor on read and reports unread docs after a new write", async () => {
    const s = await baseScenario();
    const token = await agentTokenFor(s, ["search", "read", "update"]);

    // First read seeds the cursor at current version.
    await tool(token, "pageden_read_document", { documentId: s.docId });
    const empty = toolJson(await tool(token, "pageden_my_unread", {}));
    expect(empty.documents).toHaveLength(0);

    // Bump the version via a web edit; the agent's cursor is now stale.
    const put = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# Updated\n" },
    });
    expect(put.statusCode).toBe(200);
    const unread = toolJson(await tool(token, "pageden_my_unread", {}));
    expect(unread.documents).toHaveLength(1);
    expect(unread.documents[0].id).toBe(s.docId);
    expect(unread.documents[0].lastReadVersion).toBe(s.version);
    expect(unread.documents[0].version).toBe(put.json().version);

    // A fresh read marks it as caught up.
    await tool(token, "pageden_read_document", { documentId: s.docId });
    expect(toolJson(await tool(token, "pageden_my_unread", {})).documents).toHaveLength(0);
  });
});

describe("document claims (REST + MCP + dashboard)", () => {
  it("claim/release/list flow via REST", async () => {
    const s = await baseScenario();
    const claim = await req({ method: "POST", url: `/api/documents/${s.docId}/claim`, cookies: s.adminCookie, payload: { ttlMinutes: 10 } });
    expect(claim.statusCode).toBe(201);
    expect(claim.json().claim.active).toBe(true);

    const list = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/claims`, cookies: s.adminCookie });
    expect(list.json().claims).toHaveLength(1);
    expect(list.json().claims[0].document.id).toBe(s.docId);

    const dashboard = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/dashboard`, cookies: s.adminCookie });
    expect(dashboard.json().activeClaims).toHaveLength(1);

    const release = await req({ method: "POST", url: `/api/documents/${s.docId}/release`, cookies: s.adminCookie });
    expect(release.statusCode).toBe(200);
    expect(release.json().claim.releasedAt).toBeTruthy();
  });

  it("rejects a competing actor's claim until the holder releases", async () => {
    const s = await baseScenario();
    const tokenA = await agentTokenFor(s, ["read", "update"]);
    const tokenB = await agentTokenFor(s, ["read", "update"]);

    const claimed = toolJson(await tool(tokenA, "pageden_claim_document", { documentId: s.docId, ttlMinutes: 5 }));
    expect(claimed.active).toBe(true);

    const conflict = await tool(tokenB, "pageden_claim_document", { documentId: s.docId });
    expect(conflict.json().error.message).toMatch(/Already claimed/i);

    // A's release lets B claim.
    await tool(tokenA, "pageden_release_document", { documentId: s.docId });
    const second = toolJson(await tool(tokenB, "pageden_claim_document", { documentId: s.docId }));
    expect(second.active).toBe(true);
  });

  it("rejects invalid ttlMinutes", async () => {
    const s = await baseScenario();
    const res = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/claim`,
      cookies: s.adminCookie,
      payload: { ttlMinutes: -3 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.ttlMinutes).toBeTruthy();
  });
});

describe("MCP comment tools", () => {
  it("add + list + resolve via MCP", async () => {
    const s = await baseScenario();
    const token = await agentTokenFor(s, ["search", "read", "create", "update"]);

    const added = toolJson(await tool(token, "pageden_add_section_comment", {
      documentId: s.docId,
      sectionAnchor: "acceptance-criteria",
      body: "Confirm rollout plan",
    }));
    expect(added.body).toBe("Confirm rollout plan");
    expect(added.authorTokenId).toBeTruthy();

    const list = toolJson(await tool(token, "pageden_list_comments", { documentId: s.docId }));
    expect(list.comments).toHaveLength(1);

    const resolved = toolJson(await tool(token, "pageden_resolve_comment", { commentId: added.id }));
    expect(resolved.resolvedAt).toBeTruthy();
  });
});
