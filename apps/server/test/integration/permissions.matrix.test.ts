import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, grant } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

type Actor = "viewer" | "editor" | "manager" | "admin" | "nonmember";

type Scenario = Awaited<ReturnType<typeof baseScenario>>;

async function cookieFor(s: Scenario, actor: Actor): Promise<Record<string, string>> {
  if (actor === "admin") return s.adminCookie;
  if (actor === "nonmember") {
    const u = await createUser(`nonmember-${Date.now()}@t.co`);
    return sessionFor(u.id); // no workspace membership
  }
  const u = await createUser(`${actor}-${Date.now()}@t.co`);
  await addMember(s.ws.id, u.id, "member");
  await grant(s.ws.id, "user", u.id, "folder", s.folderId, actor);
  return sessionFor(u.id);
}

const actions = {
  read: (s: Scenario, c: Record<string, string>) =>
    req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: c }),
  createChild: (s: Scenario, c: Record<string, string>) =>
    req({ method: "POST", url: "/api/documents", cookies: c, payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "C", slug: "child", content: "x" } }),
  update: (s: Scenario, c: Record<string, string>) =>
    req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: c, payload: { baseVersion: s.version, content: "# upd\n" } }),
  rename: (s: Scenario, c: Record<string, string>) =>
    req({ method: "POST", url: `/api/documents/${s.docId}/rename`, cookies: c, payload: { slug: "renamed" } }),
  remove: (s: Scenario, c: Record<string, string>) =>
    req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: c }),
  managePerms: (s: Scenario, c: Record<string, string>) =>
    req({ method: "PUT", url: `/api/documents/${s.docId}/permissions`, cookies: c, payload: { permissions: [] } }),
};

// expected[action][actor] = status code
const expected: Record<keyof typeof actions, Record<Actor, number>> = {
  read:        { viewer: 200, editor: 200, manager: 200, admin: 200, nonmember: 404 },
  createChild: { viewer: 403, editor: 201, manager: 201, admin: 201, nonmember: 404 },
  update:      { viewer: 403, editor: 200, manager: 200, admin: 200, nonmember: 404 },
  rename:      { viewer: 403, editor: 403, manager: 200, admin: 200, nonmember: 404 },
  remove:      { viewer: 403, editor: 403, manager: 200, admin: 200, nonmember: 404 },
  managePerms: { viewer: 403, editor: 403, manager: 200, admin: 200, nonmember: 404 },
};

describe("permission matrix (role × action)", () => {
  for (const action of Object.keys(actions) as Array<keyof typeof actions>) {
    for (const actor of Object.keys(expected[action]) as Actor[]) {
      it(`${action} as ${actor} → ${expected[action][actor]}`, async () => {
        const s = await baseScenario();
        const cookie = await cookieFor(s, actor);
        const res = await actions[action](s, cookie);
        expect(res.statusCode).toBe(expected[action][actor]);
      });
    }
  }
});

describe("permission inheritance & overrides", () => {
  it("a folder grant flows down to documents", async () => {
    const s = await baseScenario();
    const u = await createUser("inh@t.co");
    await addMember(s.ws.id, u.id, "member");
    await grant(s.ws.id, "user", u.id, "folder", s.folderId, "editor");
    const res = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: sessionFor(u.id), payload: { baseVersion: s.version, content: "# ok\n" } });
    expect(res.statusCode).toBe(200);
  });

  it("a document-level grant overrides to the strongest role", async () => {
    const s = await baseScenario();
    const u = await createUser("ovr@t.co");
    await addMember(s.ws.id, u.id, "member");
    await grant(s.ws.id, "user", u.id, "folder", s.folderId, "viewer");
    await grant(s.ws.id, "user", u.id, "document", s.docId, "manager");
    const res = await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: sessionFor(u.id) });
    expect(res.statusCode).toBe(200);
  });

  it("a group grant grants its members", async () => {
    const s = await baseScenario();
    const u = await createUser("grp@t.co");
    await addMember(s.ws.id, u.id, "member");
    const g = await prisma.group.create({ data: { workspaceId: s.ws.id, name: "Eng", slug: "eng" } });
    await prisma.groupMembership.create({ data: { groupId: g.id, userId: u.id } });
    await grant(s.ws.id, "group", g.id, "folder", s.folderId, "editor");
    const res = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: sessionFor(u.id), payload: { baseVersion: s.version, content: "# g\n" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("permission effects (state actually changes / does not change)", () => {
  async function granted(s: Scenario, role: "viewer" | "editor" | "manager") {
    const u = await createUser(`${role}-fx-${Date.now()}@t.co`);
    await addMember(s.ws.id, u.id, "member");
    await grant(s.ws.id, "user", u.id, "folder", s.folderId, role);
    return sessionFor(u.id);
  }

  it("editor update persists new content + version", async () => {
    const s = await baseScenario();
    const c = await granted(s, "editor");
    const res = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: c, payload: { baseVersion: s.version, content: "# changed" } });
    expect(res.statusCode).toBe(200);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: s.docId } });
    expect(doc.currentVersionId).toBe(res.json().version);
    expect(doc.currentVersionId).not.toBe(s.version);
  });

  it("viewer update is rejected AND leaves content unchanged", async () => {
    const s = await baseScenario();
    const c = await granted(s, "viewer");
    const before = await prisma.document.findUniqueOrThrow({ where: { id: s.docId } });
    const res = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: c, payload: { baseVersion: s.version, content: "# hacked" } });
    expect(res.statusCode).toBe(403);
    const after = await prisma.document.findUniqueOrThrow({ where: { id: s.docId } });
    expect(after.currentVersionId).toBe(before.currentVersionId);
  });

  it("manager delete actually soft-deletes (read becomes 404)", async () => {
    const s = await baseScenario();
    const c = await granted(s, "manager");
    expect((await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: c })).statusCode).toBe(200);
    const row = await prisma.document.findUniqueOrThrow({ where: { id: s.docId } });
    expect(row.deletedAt).not.toBeNull();
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: c })).statusCode).toBe(404);
  });

  it("manager managePerms REPLACES rows (old grants removed, new applied)", async () => {
    const s = await baseScenario();
    const c = await granted(s, "manager");
    const stale = await createUser("stale@t.co");
    await addMember(s.ws.id, stale.id, "member");
    const other = await createUser("perm-target@t.co");
    await addMember(s.ws.id, other.id, "member");
    // seed an existing document grant for `stale`
    await grant(s.ws.id, "user", stale.id, "document", s.docId, "editor");
    const res = await req({ method: "PUT", url: `/api/documents/${s.docId}/permissions`, cookies: c, payload: { permissions: [{ subjectType: "user", subjectId: other.id, role: "viewer" }] } });
    expect(res.statusCode).toBe(200);
    const rows = await prisma.permission.findMany({ where: { resourceType: "document", resourceId: s.docId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectId).toBe(other.id);
    expect(rows.some((r) => r.subjectId === stale.id)).toBe(false);
  });
});
