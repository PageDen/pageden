import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, createWorkspace, grant } from "../fixtures/seed.js";
import { sessionFor } from "../helpers/app.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

describe("permission endpoints", () => {
  it("GET/PUT folder permissions round-trips", async () => {
    const s = await baseScenario();
    const u = await createUser("fp@t.co");
    await addMember(s.ws.id, u.id, "member");
    const put = await req({ method: "PUT", url: `/api/folders/${s.folderId}/permissions`, cookies: s.adminCookie, payload: { permissions: [{ subjectType: "user", subjectId: u.id, role: "editor" }] } });
    expect(put.statusCode).toBe(200);
    const get = await req({ method: "GET", url: `/api/folders/${s.folderId}/permissions`, cookies: s.adminCookie });
    expect(typeof get.json().version).toBe("string");
    expect(get.json().permissions).toHaveLength(1);
    expect(get.json().permissions[0].role).toBe("editor");
    expect(get.json().permissions[0].subject).toMatchObject({ type: "user", id: u.id, email: "fp@t.co" });
  });

  it("rejects a subject that is not in the workspace", async () => {
    const s = await baseScenario();
    const wsB = await createWorkspace("B", "b");
    const foreignGroup = await prisma.group.create({ data: { workspaceId: wsB.id, name: "G", slug: "g" } });
    const outsider = await createUser("outsider@t.co"); // not a member of s.ws
    const g = await req({ method: "PUT", url: `/api/folders/${s.folderId}/permissions`, cookies: s.adminCookie, payload: { permissions: [{ subjectType: "group", subjectId: foreignGroup.id, role: "editor" }] } });
    expect(g.statusCode).toBe(400);
    const u = await req({ method: "PUT", url: `/api/folders/${s.folderId}/permissions`, cookies: s.adminCookie, payload: { permissions: [{ subjectType: "user", subjectId: outsider.id, role: "viewer" }] } });
    expect(u.statusCode).toBe(400);
  });

  it("dedupes duplicate (subjectType, subjectId) entries in one request (last wins)", async () => {
    const s = await baseScenario();
    const u = await createUser("dd@t.co");
    await addMember(s.ws.id, u.id, "member");
    const res = await req({ method: "PUT", url: `/api/documents/${s.docId}/permissions`, cookies: s.adminCookie, payload: { permissions: [
      { subjectType: "user", subjectId: u.id, role: "viewer" },
      { subjectType: "user", subjectId: u.id, role: "manager" },
    ] } });
    expect(res.statusCode).toBe(200);
    const rows = await prisma.permission.findMany({ where: { resourceType: "document", resourceId: s.docId, userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("manager");
  });

  it("rejects stale permission writes when a version is supplied", async () => {
    const s = await baseScenario();
    const u = await createUser("versioned@t.co");
    await addMember(s.ws.id, u.id, "member");
    const initial = await req({ method: "GET", url: `/api/documents/${s.docId}/permissions`, cookies: s.adminCookie });
    expect(initial.statusCode).toBe(200);
    const version = initial.json().version;

    const first = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}/permissions`,
      cookies: s.adminCookie,
      payload: { version, permissions: [{ subjectType: "user", subjectId: u.id, role: "viewer" }] },
    });
    expect(first.statusCode).toBe(200);

    const stale = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}/permissions`,
      cookies: s.adminCookie,
      payload: { version, permissions: [{ subjectType: "user", subjectId: u.id, role: "manager" }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "conflict", currentVersion: first.json().version });
  });

  it("grants document access to an existing user by email and adds them as a guest", async () => {
    const s = await baseScenario();
    const u = await createUser("shared.person@t.co", "Shared Person");

    const res = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions/grant`,
      cookies: s.adminCookie,
      payload: { email: " shared.person@t.co ", role: "viewer" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      membershipCreated: true,
      user: { id: u.id, email: "shared.person@t.co" },
      permission: { subjectType: "user", subjectId: u.id, role: "viewer" },
    });

    const membership = await prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: s.ws.id, userId: u.id } },
      select: { role: true },
    });
    expect(membership?.role).toBe("guest");

    const doc = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: sessionFor(u.id) });
    expect(doc.statusCode).toBe(200);
    expect(doc.json().permission).toBe("viewer");

    const get = await req({ method: "GET", url: `/api/documents/${s.docId}/permissions`, cookies: s.adminCookie });
    expect(get.statusCode).toBe(200);
    expect(get.json().permissions[0]).toMatchObject({
      subjectType: "user",
      subjectId: u.id,
      subject: { type: "user", id: u.id, email: "shared.person@t.co", name: "Shared Person" },
    });
  });

  it("grants folder access to an existing user by email for child documents", async () => {
    const s = await baseScenario();
    const u = await createUser("folder-share@t.co");

    const res = await req({
      method: "POST",
      url: `/api/folders/${s.folderId}/permissions/grant`,
      cookies: s.adminCookie,
      payload: { email: u.email, role: "editor" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ membershipCreated: true, permission: { subjectId: u.id, role: "editor" } });

    const doc = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: sessionFor(u.id) });
    expect(doc.statusCode).toBe(200);
    expect(doc.json().permission).toBe("editor");
  });

  it("returns a friendly validation error when sharing to an unknown email", async () => {
    const s = await baseScenario();
    const res = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions/grant`,
      cookies: s.adminCookie,
      payload: { email: "nobody@t.co", role: "viewer" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "validation_error",
      fields: { email: expect.stringContaining("No PageDen user exists") },
    });
  });

  it("does not allow non-managers to grant permissions", async () => {
    const s = await baseScenario();
    const editor = await createUser("editor@t.co");
    const target = await createUser("target@t.co");
    await addMember(s.ws.id, editor.id, "member");
    await grant(s.ws.id, "user", editor.id, "document", s.docId, "editor");

    const res = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions/grant`,
      cookies: sessionFor(editor.id),
      payload: { email: target.email, role: "viewer" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns inherited permissions from ancestor folders for a document", async () => {
    const s = await baseScenario();
    const ancestor = await createUser("ancestor@t.co", "Ancestor");
    await addMember(s.ws.id, ancestor.id, "member");
    // Grant on the folder that owns the document — the document is the
    // resource we GET, the grant is on its parent folder.
    await grant(s.ws.id, "user", ancestor.id, "folder", s.folderId, "editor");

    const res = await req({ method: "GET", url: `/api/documents/${s.docId}/permissions`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The document itself has no explicit grants, so `permissions` is empty.
    expect(body.permissions).toEqual([]);
    // …but `inheritedPermissions` surfaces the ancestor's grant tagged with
    // the folder it came from.
    expect(body.inheritedPermissions).toHaveLength(1);
    expect(body.inheritedPermissions[0]).toMatchObject({
      subjectType: "user",
      subjectId: ancestor.id,
      role: "editor",
      inheritedFrom: { folderId: s.folderId },
    });
    expect(typeof body.inheritedPermissions[0].inheritedFrom.folderPath).toBe("string");
  });

  it("returns inherited permissions for a nested folder", async () => {
    const s = await baseScenario();
    const subFolder = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, parentFolderId: s.folderId, name: "Sub", slug: "sub" },
    });
    expect(subFolder.statusCode).toBe(201);
    const subFolderId = subFolder.json().id as string;
    const ancestor = await createUser("nested@t.co", "Nested");
    await addMember(s.ws.id, ancestor.id, "member");
    await grant(s.ws.id, "user", ancestor.id, "folder", s.folderId, "viewer");

    const res = await req({ method: "GET", url: `/api/folders/${subFolderId}/permissions`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.permissions).toEqual([]);
    expect(body.inheritedPermissions).toHaveLength(1);
    expect(body.inheritedPermissions[0]).toMatchObject({
      subjectType: "user",
      subjectId: ancestor.id,
      role: "viewer",
      inheritedFrom: { folderId: s.folderId },
    });
  });

  it("POST /documents/:id/permissions adds a single grant by subject id", async () => {
    const s = await baseScenario();
    const u = await createUser("rowadd@t.co");
    await addMember(s.ws.id, u.id, "member");
    const post = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions`,
      cookies: s.adminCookie,
      payload: { subjectType: "user", subjectId: u.id, role: "viewer" },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toMatchObject({
      ok: true,
      permission: { subjectType: "user", subjectId: u.id, role: "viewer" },
    });
    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/permissions`, cookies: s.adminCookie });
    expect(list.json().permissions).toHaveLength(1);
  });

  it("POST /documents/:id/permissions rejects a duplicate subject with 409", async () => {
    const s = await baseScenario();
    const u = await createUser("dup@t.co");
    await addMember(s.ws.id, u.id, "member");
    await grant(s.ws.id, "user", u.id, "document", s.docId, "viewer");
    const post = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions`,
      cookies: s.adminCookie,
      payload: { subjectType: "user", subjectId: u.id, role: "editor" },
    });
    expect(post.statusCode).toBe(409);
  });

  it("PATCH /documents/:id/permissions/:permId changes the role", async () => {
    const s = await baseScenario();
    const u = await createUser("patch@t.co");
    await addMember(s.ws.id, u.id, "member");
    const seed = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions`,
      cookies: s.adminCookie,
      payload: { subjectType: "user", subjectId: u.id, role: "viewer" },
    });
    const permissionId = seed.json().permission.id as string;
    const patch = await req({
      method: "PATCH",
      url: `/api/documents/${s.docId}/permissions/${permissionId}`,
      cookies: s.adminCookie,
      payload: { role: "manager" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ ok: true, permission: { role: "manager" } });
  });

  it("DELETE /documents/:id/permissions/:permId removes the grant", async () => {
    const s = await baseScenario();
    const u = await createUser("delperm@t.co");
    await addMember(s.ws.id, u.id, "member");
    const seed = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions`,
      cookies: s.adminCookie,
      payload: { subjectType: "user", subjectId: u.id, role: "viewer" },
    });
    const permissionId = seed.json().permission.id as string;
    const del = await req({
      method: "DELETE",
      url: `/api/documents/${s.docId}/permissions/${permissionId}`,
      cookies: s.adminCookie,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/permissions`, cookies: s.adminCookie });
    expect(list.json().permissions).toHaveLength(0);
  });

  it("rejects per-row endpoints from non-managers", async () => {
    const s = await baseScenario();
    const target = await createUser("perm-target@t.co");
    await addMember(s.ws.id, target.id, "member");
    const editor = await createUser("perm-editor@t.co");
    await addMember(s.ws.id, editor.id, "member");
    await grant(s.ws.id, "user", editor.id, "document", s.docId, "editor");

    const post = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/permissions`,
      cookies: sessionFor(editor.id),
      payload: { subjectType: "user", subjectId: target.id, role: "viewer" },
    });
    expect(post.statusCode).toBe(403);
  });

  it("does not double-surface a subject that also has an explicit grant", async () => {
    const s = await baseScenario();
    const dual = await createUser("dual@t.co", "Dual");
    await addMember(s.ws.id, dual.id, "member");
    // Explicit grant on the document itself
    await grant(s.ws.id, "user", dual.id, "document", s.docId, "editor");
    // …and another grant on the parent folder
    await grant(s.ws.id, "user", dual.id, "folder", s.folderId, "viewer");

    const res = await req({ method: "GET", url: `/api/documents/${s.docId}/permissions`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]).toMatchObject({ subjectId: dual.id, role: "editor" });
    expect(body.inheritedPermissions).toEqual([]);
  });
});
