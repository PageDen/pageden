import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, createWorkspace } from "../fixtures/seed.js";

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
    const rows = await prisma.permission.findMany({ where: { resourceType: "document", resourceId: s.docId, subjectId: u.id } });
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
});
