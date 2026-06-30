import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member } from "../fixtures/seed.js";

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

async function uploadAttachment(docId: string, adminCookie: Record<string, string>, filename: string, body = Buffer.from("png-bytes")) {
  const res = await req({
    method: "POST",
    url: `/api/documents/${docId}/attachments?filename=${encodeURIComponent(filename)}`,
    headers: { "content-type": "image/png" },
    cookies: adminCookie,
    payload: body,
  });
  expect(res.statusCode).toBe(202);
  return res;
}

describe("DocumentShare REST + public share API", () => {
  it("manager creates a share; anonymous public API returns sanitized Markdown", async () => {
    const s = await baseScenario();
    const create = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/share`,
      cookies: s.adminCookie,
      payload: { ttlDays: 7 },
    });
    expect(create.statusCode).toBe(201);
    const share = create.json().share;
    expect(share.active).toBe(true);
    expect(share.hasPassword).toBe(false);
    expect(share.targetType).toBe("document");
    expect(share.documentId).toBe(s.docId);

    // No auth headers on this request.
    const anon = await req({ method: "GET", url: `/api/public/shares/${share.slug}` });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().title).toBe("Runbook");
    expect(anon.json().content).toContain("# Runbook");
    expect(anon.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("rejects share creation by non-manager", async () => {
    const s = await baseScenario();
    const other = await member(s.ws.id, "viewer@t.co", "member");
    const res = await req({ method: "POST", url: `/api/documents/${s.docId}/share`, cookies: other.cookie, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("expired share returns 404 anonymously", async () => {
    const s = await baseScenario();
    const create = await req({ method: "POST", url: `/api/documents/${s.docId}/share`, cookies: s.adminCookie, payload: {} });
    const shareId = create.json().share.id as string;
    // Bypass the API to fast-forward the expiry — covers the "share existed but expired" branch.
    await prisma.documentShare.update({ where: { id: shareId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const slug = create.json().share.slug as string;
    const res = await req({ method: "GET", url: `/api/public/shares/${slug}` });
    expect(res.statusCode).toBe(404);
  });

  it("revoked share returns 404 (no existence leak)", async () => {
    const s = await baseScenario();
    const create = await req({ method: "POST", url: `/api/documents/${s.docId}/share`, cookies: s.adminCookie, payload: {} });
    const shareId = create.json().share.id as string;
    const slug = create.json().share.slug as string;

    const del = await req({ method: "DELETE", url: `/api/shares/${shareId}`, cookies: s.adminCookie });
    expect(del.statusCode).toBe(200);
    expect(del.json().share.active).toBe(false);

    const res = await req({ method: "GET", url: `/api/public/shares/${slug}` });
    expect(res.statusCode).toBe(404);
  });

  it("password-protected share asks for password and rejects wrong ones", async () => {
    const s = await baseScenario();
    const create = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/share`,
      cookies: s.adminCookie,
      payload: { password: "hunter2" },
    });
    expect(create.json().share.hasPassword).toBe(true);
    const slug = create.json().share.slug as string;

    const noPw = await req({ method: "GET", url: `/api/public/shares/${slug}` });
    expect(noPw.statusCode).toBe(401);
    expect(noPw.json().error).toBe("password_required");

    const wrong = await req({ method: "GET", url: `/api/public/shares/${slug}?password=oops` });
    expect(wrong.statusCode).toBe(403);

    const ok = await req({ method: "GET", url: `/api/public/shares/${slug}?password=hunter2` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().content).toContain("# Runbook");
  });

  it("allowIndexing flips the x-robots-tag header", async () => {
    const s = await baseScenario();
    const create = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/share`,
      cookies: s.adminCookie,
      payload: { allowIndexing: true },
    });
    const slug = create.json().share.slug as string;
    const res = await req({ method: "GET", url: `/api/public/shares/${slug}` });
    expect(res.headers["x-robots-tag"]).toBe("all");
  });

  it("workspace shares list only returns shares the caller can manage", async () => {
    const s = await baseScenario();
    await req({ method: "POST", url: `/api/documents/${s.docId}/share`, cookies: s.adminCookie, payload: {} });
    const list = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/shares`, cookies: s.adminCookie });
    expect(list.json().shares).toHaveLength(1);

    const other = await member(s.ws.id, "v@t.co", "member");
    const others = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/shares`, cookies: other.cookie });
    // The other user is a workspace member but has no role on the doc — should see nothing.
    expect(others.json().shares).toHaveLength(0);
  });

  it("manager creates a folder share; list filters it through folder manager access", async () => {
    const s = await baseScenario();
    const create = await req({
      method: "POST",
      url: `/api/folders/${s.folderId}/share`,
      cookies: s.adminCookie,
      payload: { ttlDays: 7, allowIndexing: true },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().share).toMatchObject({
      targetType: "folder",
      folderId: s.folderId,
      allowIndexing: true,
      active: true,
    });

    const list = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/shares`, cookies: s.adminCookie });
    expect(list.statusCode).toBe(200);
    expect(list.json().shares).toHaveLength(1);
    expect(list.json().shares[0].targetType).toBe("folder");

    const other = await member(s.ws.id, "folder-viewer@t.co", "member");
    const others = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/shares`, cookies: other.cookie });
    expect(others.statusCode).toBe(200);
    expect(others.json().shares).toHaveLength(0);
  });

  it("rejects folder share creation by non-manager", async () => {
    const s = await baseScenario();
    const other = await member(s.ws.id, "folder-share-denied@t.co", "member");
    const res = await req({ method: "POST", url: `/api/folders/${s.folderId}/share`, cookies: other.cookie, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("public sharing kill switch refuses creation and hides existing slugs", async () => {
    const s = await baseScenario();
    const create = await req({ method: "POST", url: `/api/documents/${s.docId}/share`, cookies: s.adminCookie, payload: {} });
    expect(create.statusCode).toBe(201);
    const slug = create.json().share.slug as string;

    const disabled = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/settings/public-sharing`,
      cookies: s.adminCookie,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().enabled).toBe(false);

    const hidden = await req({ method: "GET", url: `/api/public/shares/${slug}` });
    expect(hidden.statusCode).toBe(404);

    const docCreate = await req({ method: "POST", url: `/api/documents/${s.docId}/share`, cookies: s.adminCookie, payload: {} });
    expect(docCreate.statusCode).toBe(403);

    const folderCreate = await req({ method: "POST", url: `/api/folders/${s.folderId}/share`, cookies: s.adminCookie, payload: {} });
    expect(folderCreate.statusCode).toBe(403);
  });

  it("DocumentShare target XOR rejects invalid rows", async () => {
    const s = await baseScenario();
    await expect(
      prisma.documentShare.create({
        data: {
          workspaceId: s.ws.id,
          documentId: s.docId,
          folderId: s.folderId,
          slug: "invalid-both-targets",
          createdById: s.admin.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("public manual manifest includes canonical subtree docs and rewrites attachment URLs", async () => {
    const s = await baseScenario();
    const attachment = await uploadAttachment(s.docId, s.adminCookie, "diagram.png");
    const attachmentId = attachment.json().id as string;
    const update = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: s.version,
        content: `# Runbook\n\n![diagram](/api/attachments/${attachmentId})\n`,
      },
    });
    expect(update.statusCode).toBe(200);

    const draft = await req({
      method: "POST",
      url: "/api/documents",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "Draft Doc", slug: "draft-doc", content: "# Draft\n" },
    });
    expect(draft.statusCode).toBe(201);
    await prisma.document.update({ where: { id: draft.json().id as string }, data: { status: "draft" } });

    const create = await req({ method: "POST", url: `/api/folders/${s.folderId}/share`, cookies: s.adminCookie, payload: {} });
    const slug = create.json().share.slug as string;
    const manifest = await req({ method: "GET", url: `/api/public/shares/${slug}` });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().type).toBe("manual");
    expect(manifest.json().nav.map((item: { docId: string }) => item.docId)).toEqual([s.docId]);
    expect(manifest.json().landing.content).toContain(`/api/public/shares/${slug}/attachments/${attachmentId}`);
    expect(manifest.json().landing.content).not.toContain(`/api/attachments/${attachmentId}`);
  });

  it("public manual page uses stable docId URLs and enforces subtree containment", async () => {
    const s = await baseScenario();
    const create = await req({ method: "POST", url: `/api/folders/${s.folderId}/share`, cookies: s.adminCookie, payload: {} });
    const slug = create.json().share.slug as string;

    const beforeRename = await req({ method: "GET", url: `/api/public/shares/${slug}/page?docId=${s.docId}` });
    expect(beforeRename.statusCode).toBe(200);
    expect(beforeRename.json().title).toBe("Runbook");

    const renamed = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/rename`,
      cookies: s.adminCookie,
      payload: { title: "Renamed Runbook", slug: "renamed-runbook" },
    });
    expect(renamed.statusCode).toBe(200);
    const afterRename = await req({ method: "GET", url: `/api/public/shares/${slug}/page?docId=${s.docId}` });
    expect(afterRename.statusCode).toBe(200);
    expect(afterRename.json().title).toBe("Renamed Runbook");

    const outsideFolder = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, name: "Outside", slug: "outside" },
    });
    expect(outsideFolder.statusCode).toBe(201);
    const moved = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/move`,
      cookies: s.adminCookie,
      payload: { folderId: outsideFolder.json().id },
    });
    expect(moved.statusCode).toBe(200);
    const afterMove = await req({ method: "GET", url: `/api/public/shares/${slug}/page?docId=${s.docId}` });
    expect(afterMove.statusCode).toBe(404);
  });

  it("public manual page rejects docs outside the shared subtree", async () => {
    const s = await baseScenario();
    const outsideFolder = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, name: "Outside", slug: "outside" },
    });
    expect(outsideFolder.statusCode).toBe(201);
    const outsideDoc = await req({
      method: "POST",
      url: "/api/documents",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, folderId: outsideFolder.json().id, title: "Outside", slug: "outside-doc", content: "# Outside\n" },
    });
    expect(outsideDoc.statusCode).toBe(201);
    const create = await req({ method: "POST", url: `/api/folders/${s.folderId}/share`, cookies: s.adminCookie, payload: {} });
    const slug = create.json().share.slug as string;
    const res = await req({ method: "GET", url: `/api/public/shares/${slug}/page?docId=${outsideDoc.json().id}` });
    expect(res.statusCode).toBe(404);
  });

  it("public attachment proxy streams in-subtree attachments and hides out-of-subtree attachments", async () => {
    const s = await baseScenario();
    const inBytes = Buffer.from("inside-image");
    const inside = await uploadAttachment(s.docId, s.adminCookie, "inside.png", inBytes);
    const create = await req({ method: "POST", url: `/api/folders/${s.folderId}/share`, cookies: s.adminCookie, payload: {} });
    const slug = create.json().share.slug as string;

    const ok = await req({ method: "GET", url: `/api/public/shares/${slug}/attachments/${inside.json().id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(ok.body).equals(inBytes)).toBe(true);

    const outsideFolder = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, name: "Outside", slug: "outside" },
    });
    const outsideDoc = await req({
      method: "POST",
      url: "/api/documents",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, folderId: outsideFolder.json().id, title: "Outside", slug: "outside-doc", content: "# Outside\n" },
    });
    const outside = await uploadAttachment(outsideDoc.json().id as string, s.adminCookie, "outside.png");
    const hidden = await req({ method: "GET", url: `/api/public/shares/${slug}/attachments/${outside.json().id}` });
    expect(hidden.statusCode).toBe(404);
  });
});

describe("MCP share tools", () => {
  async function agentToken(s: Awaited<ReturnType<typeof baseScenario>>) {
    const created = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Share agent", kind: "agent", workspaceId: s.ws.id, scopes: ["read", "update"] },
    });
    expect(created.statusCode).toBe(201);
    return created.json().token as string;
  }

  it("pageden_share_document creates a share; pageden_list_shares finds it; pageden_revoke_share removes it", async () => {
    const s = await baseScenario();
    const token = await agentToken(s);

    const created = toolJson(await tool(token, "pageden_share_document", { documentId: s.docId, ttlDays: 30 }));
    expect(created.active).toBe(true);

    const list = toolJson(await tool(token, "pageden_list_shares", {}));
    expect(list.shares).toHaveLength(1);
    expect(list.shares[0].id).toBe(created.id);

    const revoked = toolJson(await tool(token, "pageden_revoke_share", { shareId: created.id }));
    expect(revoked.active).toBe(false);
    expect(revoked.revokedAt).toBeTruthy();
  });
});
