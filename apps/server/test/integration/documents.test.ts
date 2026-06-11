import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member, createWorkspace, createUser, addMember } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

describe("documents — endpoints & validation", () => {
  it("creates, reads, lists, and trees a document", async () => {
    const s = await baseScenario();
    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toBe("# Runbook\n");
    expect(read.json().version).toBe(s.version);
    expect(read.json().aiReadiness).toMatchObject({ status: expect.any(String), score: expect.any(Number), issues: expect.any(Array) });

    const list = await req({ method: "GET", url: `/api/documents?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    expect(list.json().documents).toHaveLength(1);

    const tree = await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    expect(tree.json().folders).toHaveLength(1);
    expect(tree.json().documents).toHaveLength(1);
  });

  it("requires workspaceId on list", async () => {
    const s = await baseScenario();
    const res = await req({ method: "GET", url: "/api/documents", cookies: s.adminCookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.workspaceId).toBeTruthy();
  });

  it("rejects an invalid slug and a duplicate sibling slug", async () => {
    const s = await baseScenario();
    const bad = await req({ method: "POST", url: "/api/documents", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "X", slug: "Bad Slug", content: "x" } });
    expect(bad.statusCode).toBe(400);
    const dup = await req({ method: "POST", url: "/api/documents", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "Dup", slug: "runbook", content: "x" } });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toBe("validation_error");
  });

  it("conflict matrix: correct base → 200, stale → 409, missing → 400", async () => {
    const s = await baseScenario();
    const ok = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, payload: { baseVersion: s.version, content: "# v2\n" } });
    expect(ok.statusCode).toBe(200);
    const v2 = ok.json().version as string;

    const stale = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, payload: { baseVersion: s.version, content: "x" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().currentVersion).toBe(v2);

    const missing = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, payload: { content: "x" } });
    expect(missing.statusCode).toBe(400);
  });

  it("push validates checksum against canonical content", async () => {
    const s = await baseScenario();
    const res = await req({ method: "POST", url: `/api/documents/${s.docId}/push`, cookies: s.adminCookie, payload: { baseVersion: s.version, checksum: "sha256:bogus", content: "x\n" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.checksum).toBeTruthy();
  });

  it("rename, move, soft-delete, and path reuse", async () => {
    const s = await baseScenario();
    const ren = await req({ method: "POST", url: `/api/documents/${s.docId}/rename`, cookies: s.adminCookie, payload: { slug: "runbook-2" } });
    expect(ren.statusCode).toBe(200);
    expect(ren.json().path).toBe("engineering/runbook-2.md");

    const f2 = await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: "Ops", slug: "ops" } });
    const mv = await req({ method: "POST", url: `/api/documents/${s.docId}/move`, cookies: s.adminCookie, payload: { folderId: f2.json().id } });
    expect(mv.statusCode).toBe(200);
    expect(mv.json().path).toBe("ops/runbook-2.md");

    const del = await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(del.statusCode).toBe(200);
    const recreate = await req({ method: "POST", url: "/api/documents", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, folderId: f2.json().id, title: "New", slug: "runbook-2", content: "x" } });
    expect(recreate.statusCode).toBe(201);
  });

  it("revisions and restore", async () => {
    const s = await baseScenario();
    await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, payload: { baseVersion: s.version, content: "# v2\n" } });
    const revs = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: s.adminCookie });
    const revisions = revs.json().revisions as Array<{ id: string }>;
    expect(revisions.length).toBe(2);
    const oldest = revisions[revisions.length - 1]!;
    const restore = await req({ method: "POST", url: `/api/documents/${s.docId}/revisions/${oldest.id}/restore`, cookies: s.adminCookie });
    expect(restore.statusCode).toBe(200);
    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(read.json().content).toBe("# Runbook\n");
  });

  it("hides documents the user cannot see (404 on read, absent from list)", async () => {
    const s = await baseScenario();
    const { cookie } = await member(s.ws.id, "nobody@t.co", "member");
    const list = await req({ method: "GET", url: `/api/documents?workspaceId=${s.ws.id}`, cookies: cookie });
    expect(list.json().documents).toHaveLength(0);
    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: cookie });
    expect(read.statusCode).toBe(404);
  });

  it("list/tree are scoped to the workspace and assert representative fields", async () => {
    const s = await baseScenario();
    // a second workspace the admin is NOT part of, with its own doc
    const wsB = await createWorkspace("B", "b");
    const adminB = await createUser("adminb@t.co");
    await addMember(wsB.id, adminB.id, "admin");
    const { sessionFor } = await import("../helpers/app.js");
    const fb = await req({ method: "POST", url: "/api/folders", cookies: sessionFor(adminB.id), payload: { workspaceId: wsB.id, name: "Fb", slug: "fb" } });
    await req({ method: "POST", url: "/api/documents", cookies: sessionFor(adminB.id), payload: { workspaceId: wsB.id, folderId: fb.json().id, title: "Secret", slug: "secret", content: "x" } });

    const list = await req({ method: "GET", url: `/api/documents?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    const docs = list.json().documents as Array<{ id: string; path: string; permission: string }>;
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(s.docId);
    expect(docs[0]!.path).toBe("engineering/runbook.md");
    expect(docs[0]!.permission).toBe("manager");
    // list metadata must not include content
    expect(Object.keys(docs[0]!)).not.toContain("content");

    const tree = await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    expect(tree.json().folders).toHaveLength(1);
    expect((tree.json().documents as Array<{ path: string }>).every((d) => !d.path.includes("secret"))).toBe(true);
  });
});
