import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member, createWorkspace, createUser, addMember } from "../fixtures/seed.js";
import { pruneCollapsedRevisions } from "../../src/documents/revision-retention.js";

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

  it("returns the document tree in deterministic natural path order", async () => {
    const s = await baseScenario();
    const parent = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, name: "Product Lifecycle Policy 2", slug: "product-lifecycle-policy-2" },
    });
    expect(parent.statusCode).toBe(201);
    const parentId = parent.json().id as string;

    const childFolders = [
      ["Phase 5 - Launch and Production", "phase-5-launch-and-production"],
      ["Phase 4 - Pre-Release and Validation", "phase-4-pre-release-and-validation"],
      ["Governance", "governance"],
      ["Phase 1 - Requirements and Planning", "phase-1-requirements-and-planning"],
      ["Phase 10 - Later Review", "phase-10-later-review"],
      ["Phase 2 - Development", "phase-2-development"],
      ["Phase 3 - Verification and Testing", "phase-3-verification-and-testing"],
    ] as const;
    for (const [name, slug] of childFolders) {
      const created = await req({
        method: "POST",
        url: "/api/folders",
        cookies: s.adminCookie,
        payload: { workspaceId: s.ws.id, parentFolderId: parentId, name, slug },
      });
      expect(created.statusCode).toBe(201);
    }

    const docs = [
      ["Reference 10", "reference-10"],
      ["Reference 2", "reference-2"],
      ["Reference 1", "reference-1"],
    ] as const;
    for (const [title, slug] of docs) {
      const created = await req({
        method: "POST",
        url: "/api/documents",
        cookies: s.adminCookie,
        payload: { workspaceId: s.ws.id, folderId: parentId, title, slug, content: "x" },
      });
      expect(created.statusCode).toBe(201);
    }

    const tree = await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    expect(tree.statusCode).toBe(200);
    const folderNames = (tree.json().folders as Array<{ parentFolderId: string | null; name: string }>)
      .filter((folder) => folder.parentFolderId === parentId)
      .map((folder) => folder.name);
    expect(folderNames).toEqual([
      "Governance",
      "Phase 1 - Requirements and Planning",
      "Phase 2 - Development",
      "Phase 3 - Verification and Testing",
      "Phase 4 - Pre-Release and Validation",
      "Phase 5 - Launch and Production",
      "Phase 10 - Later Review",
    ]);
    const documentTitles = (tree.json().documents as Array<{ folderId: string; title: string }>)
      .filter((document) => document.folderId === parentId)
      .map((document) => document.title);
    expect(documentTitles).toEqual(["Reference 1", "Reference 2", "Reference 10"]);
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

  it("transfers a document to another workspace and honors the transfer setting", async () => {
    const s = await baseScenario();
    const dest = await createWorkspace("Destination", "dest");
    await addMember(dest.id, s.admin.id, "admin");
    const destFolder = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: dest.id, name: "Inbox", slug: "inbox" },
    });
    expect(destFolder.statusCode).toBe(201);

    const disabled = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/settings/workspace-transfer`,
      cookies: s.adminCookie,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    const blocked = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/transfer-workspace`,
      cookies: s.adminCookie,
      payload: { workspaceId: dest.id, folderId: destFolder.json().id },
    });
    expect(blocked.statusCode).toBe(403);

    const enabled = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/settings/workspace-transfer`,
      cookies: s.adminCookie,
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    const moved = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/transfer-workspace`,
      cookies: s.adminCookie,
      payload: { workspaceId: dest.id, folderId: destFolder.json().id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: s.docId, workspaceId: dest.id, folderId: destFolder.json().id, path: "inbox/runbook.md" });

    const readSource = await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    expect((readSource.json().documents as unknown[])).toHaveLength(0);
    const readDest = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(readDest.statusCode).toBe(200);
    expect(readDest.json()).toMatchObject({ workspaceId: dest.id, folderId: destFolder.json().id, path: "inbox/runbook.md", content: "# Runbook\n" });
    await expect(prisma.permission.count({ where: { resourceType: "document", resourceId: s.docId } })).resolves.toBe(0);
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

  it("dedups no-op writes and updates title-only without a revision", async () => {
    const s = await baseScenario();
    const initialDoc = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    const initialChecksum = initialDoc.json().checksum as string;
    const initialAuditCount = await prisma.auditEvent.count({ where: { targetId: s.docId } });

    const noop = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# Runbook\n" },
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.json()).toMatchObject({ id: s.docId, version: s.version, checksum: initialChecksum });
    let revs = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: s.adminCookie });
    expect((revs.json().revisions as unknown[]).length).toBe(1);
    await expect(prisma.auditEvent.count({ where: { targetId: s.docId } })).resolves.toBe(initialAuditCount);

    const titleOnly = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, title: "Renamed Runbook", content: "# Runbook\n" },
    });
    expect(titleOnly.statusCode).toBe(200);
    expect(titleOnly.json()).toMatchObject({ id: s.docId, version: s.version, checksum: initialChecksum });
    revs = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: s.adminCookie });
    expect((revs.json().revisions as unknown[]).length).toBe(1);
    const afterTitle = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(afterTitle.json().title).toBe("Renamed Runbook");
    const titleAudit = await prisma.auditEvent.findFirstOrThrow({ where: { targetId: s.docId, action: "document_updated" }, orderBy: { createdAt: "desc" } });
    expect(titleAudit.metadata).toMatchObject({ version: s.version, titleOnly: true });

    const pluginNoop = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/push`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, checksum: initialChecksum, content: "# Runbook\n" },
    });
    expect(pluginNoop.statusCode).toBe(200);
    expect(pluginNoop.json()).toMatchObject({ id: s.docId, version: s.version, checksum: initialChecksum });
    revs = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: s.adminCookie });
    expect((revs.json().revisions as unknown[]).length).toBe(1);

    const changed = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# Changed\n" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().version).not.toBe(s.version);
    revs = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: s.adminCookie });
    expect((revs.json().revisions as unknown[]).length).toBe(2);

    const staleNoop = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# Changed\n" },
    });
    expect(staleNoop.statusCode).toBe(409);
  });

  it("returns a single revision with content and hides it by permission", async () => {
    const s = await baseScenario();
    const initialDoc = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    const initialChecksum = initialDoc.json().checksum as string;
    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: s.adminCookie });
    const rev = (list.json().revisions as Array<{ id: string }>)[0]!;

    const detail = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/${rev.id}`, cookies: s.adminCookie });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().revision).toMatchObject({
      id: rev.id,
      documentId: s.docId,
      versionNumber: 1,
      content: "# Runbook\n",
      checksum: initialChecksum,
      changeSource: "web_app",
      message: null,
      createdBy: { id: s.admin.id, name: s.admin.name, email: s.admin.email, avatarUrl: null },
    });
    expect(detail.json().document).toEqual({ id: s.docId, currentTitle: "Runbook" });

    const missing = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/rev_does_not_exist`, cookies: s.adminCookie });
    expect(missing.statusCode).toBe(404);

    const { cookie } = await member(s.ws.id, "revision-hidden@t.co", "member");
    const hidden = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/${rev.id}`, cookies: cookie });
    expect(hidden.statusCode).toBe(404);
  });

  it("groups rapid same-user same-source revisions without hiding their detail endpoint", async () => {
    const s = await baseScenario();
    const v2 = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# v2\n" },
    });
    const v3 = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: v2.json().version, content: "# v3\n" },
    });
    expect(v3.statusCode).toBe(200);

    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: s.adminCookie });
    expect(list.statusCode).toBe(200);
    const revisions = list.json().revisions as Array<{
      id: string;
      versionNumber: number;
      groupCount: number;
      groupStartVersionNumber: number;
      groupEndVersionNumber: number;
      collapsedRevisions: Array<{ id: string; versionNumber: number }>;
    }>;
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      id: v3.json().version,
      versionNumber: 3,
      groupCount: 2,
      groupStartVersionNumber: 2,
      groupEndVersionNumber: 3,
    });
    expect(revisions[0]!.collapsedRevisions).toEqual([
      {
        id: v2.json().version,
        versionNumber: 2,
        checksum: expect.any(String),
        createdBy: s.admin.id,
        createdAt: expect.any(String),
        changeSource: "web_app",
        message: null,
        contributorIds: [s.admin.id],
        isPinned: false,
        label: null,
      },
    ]);
    expect(revisions[1]).toMatchObject({ versionNumber: 1, groupCount: 1, collapsedRevisions: [] });

    const collapsedDetail = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/${v2.json().version}`, cookies: s.adminCookie });
    expect(collapsedDetail.statusCode).toBe(200);
    expect(collapsedDetail.json().revision.content).toBe("# v2\n");
  });

  it("shows revisions and audit events in one document history timeline", async () => {
    const s = await baseScenario();
    const v2 = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# v2\n" },
    });
    expect(v2.statusCode).toBe(200);

    const renamed = await req({
      method: "PATCH",
      url: `/api/documents/${s.docId}/revisions/${v2.json().version}`,
      cookies: s.adminCookie,
      payload: { label: "Release candidate", isPinned: true },
    });
    expect(renamed.statusCode).toBe(200);

    const history = await req({ method: "GET", url: `/api/documents/${s.docId}/history`, cookies: s.adminCookie });
    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      revisions: Array<{ id: string; label: string | null; isPinned: boolean; contributorIds: string[] }>;
      timeline: Array<{ type: "revision" | "event"; revision?: { id: string; label: string | null; isPinned: boolean }; event?: { action: string; actor: string } }>;
    };
    expect(body.revisions[0]).toMatchObject({
      id: v2.json().version,
      label: "Release candidate",
      isPinned: true,
      contributorIds: [s.admin.id],
    });
    expect(body.timeline.some((item) => item.type === "revision" && item.revision?.id === v2.json().version && item.revision.isPinned)).toBe(true);
    expect(body.timeline.some((item) => item.type === "event" && item.event?.action === "document_revision_metadata_updated" && item.event.actor === "user")).toBe(true);

    const detail = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/${v2.json().version}`, cookies: s.adminCookie });
    expect(detail.json().revision).toMatchObject({
      label: "Release candidate",
      isPinned: true,
      contributorIds: [s.admin.id],
    });
  });

  it("prunes old unprotected collapsed revisions and keeps named or pinned revisions", async () => {
    const s = await baseScenario();
    const v2 = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# v2\n" },
    });
    const v3 = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: v2.json().version, content: "# v3\n" },
    });
    expect(v3.statusCode).toBe(200);

    const old = new Date("2026-01-01T00:00:00.000Z");
    await prisma.documentRevision.updateMany({ where: { id: { in: [v2.json().version, v3.json().version] } }, data: { createdAt: old } });

    const pruned = await pruneCollapsedRevisions(prisma, { olderThanMs: 1, now: new Date("2026-01-02T00:00:00.000Z") });
    expect(pruned.pruned).toBe(1);

    const prunedDetail = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/${v2.json().version}`, cookies: s.adminCookie });
    expect(prunedDetail.statusCode).toBe(404);
    const liveDetail = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/${v3.json().version}`, cookies: s.adminCookie });
    expect(liveDetail.statusCode).toBe(200);

  });

  it("does not prune named or pinned collapsed revisions", async () => {
    const s = await baseScenario();
    const v2 = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: "# v2\n" },
    });
    const v3 = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: v2.json().version, content: "# v3\n" },
    });
    expect(v3.statusCode).toBe(200);

    const old = new Date("2026-01-01T00:00:00.000Z");
    await prisma.documentRevision.updateMany({ where: { id: { in: [v2.json().version, v3.json().version] } }, data: { createdAt: old } });
    const label = await req({
      method: "PATCH",
      url: `/api/documents/${s.docId}/revisions/${v2.json().version}`,
      cookies: s.adminCookie,
      payload: { label: "Keep this" },
    });
    expect(label.statusCode).toBe(200);

    const protectedResult = await pruneCollapsedRevisions(prisma, { olderThanMs: 1, now: new Date("2026-01-02T00:00:00.000Z") });
    expect(protectedResult.pruned).toBe(0);
    const protectedDetail = await req({ method: "GET", url: `/api/documents/${s.docId}/revisions/${v2.json().version}`, cookies: s.adminCookie });
    expect(protectedDetail.statusCode).toBe(200);
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
