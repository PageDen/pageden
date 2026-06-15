import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member, grant } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

describe("Workspace viewer tier (Phase B)", () => {
  it("a workspace-wide viewer sees every doc as viewer without an explicit grant", async () => {
    const s = await baseScenario();
    const v = await member(s.ws.id, "v@t.co", "viewer");
    const res = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: v.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().permission).toBe("viewer");
    expect(res.json().capabilities).toMatchObject({
      canView: true,
      canEdit: false,
      canDelete: false,
      canManage: false,
      canShare: false,
    });
  });

  it("a viewer with an explicit manager grant is still capped at viewer", async () => {
    const s = await baseScenario();
    const v = await member(s.ws.id, "v2@t.co", "viewer");
    // A stale higher grant must not unlock writes after a downgrade.
    await grant(s.ws.id, "user", v.user.id, "document", s.docId, "manager");

    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: v.cookie });
    expect(read.statusCode).toBe(200);
    expect(read.json().permission).toBe("viewer");
    expect(read.json().capabilities.canEdit).toBe(false);
    expect(read.json().capabilities.canManage).toBe(false);

    const update = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: v.cookie,
      payload: { baseVersion: s.version, content: "# tampered\n" },
    });
    expect(update.statusCode).toBe(403);

    const del = await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: v.cookie });
    expect(del.statusCode).toBe(403);
  });

  it("a viewer with an explicit folder editor grant is still capped at viewer for folder access", async () => {
    const s = await baseScenario();
    const v = await member(s.ws.id, "v3@t.co", "viewer");
    await grant(s.ws.id, "user", v.user.id, "folder", s.folderId, "editor");

    // Editor would normally be able to create a doc in this folder; viewer cap blocks it.
    const create = await req({
      method: "POST",
      url: "/api/documents",
      cookies: v.cookie,
      payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "X", slug: "x", content: "x" },
    });
    expect(create.statusCode).toBe(403);
  });
});

describe("Workspace guest tier (Phase B)", () => {
  it("a guest with no explicit grants sees nothing — even with a folder defaultRole", async () => {
    const s = await baseScenario();
    const g = await member(s.ws.id, "g@t.co", "guest");
    // Set the folder default role to viewer; would normally floor every member at viewer.
    const setDefault = await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: "viewer" },
    });
    expect(setDefault.statusCode).toBe(200);

    const res = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: g.cookie });
    expect(res.statusCode).toBe(404);
  });

  it("a guest with an explicit document grant sees only that document", async () => {
    const s = await baseScenario();
    const g = await member(s.ws.id, "g2@t.co", "guest");
    await grant(s.ws.id, "user", g.user.id, "document", s.docId, "viewer");

    const yes = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: g.cookie });
    expect(yes.statusCode).toBe(200);
    expect(yes.json().permission).toBe("viewer");

    // A second document in the same folder remains hidden — guests don't pick up sibling defaults.
    const sibling = await req({
      method: "POST",
      url: "/api/documents",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "Sibling", slug: "sibling", content: "x" },
    });
    expect(sibling.statusCode).toBe(201);
    const siblingId = sibling.json().id as string;

    await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: "viewer" },
    });

    const no = await req({ method: "GET", url: `/api/documents/${siblingId}`, cookies: g.cookie });
    expect(no.statusCode).toBe(404);
  });

  it("a guest can be granted editor explicitly and write within that scope", async () => {
    const s = await baseScenario();
    const g = await member(s.ws.id, "g3@t.co", "guest");
    await grant(s.ws.id, "user", g.user.id, "document", s.docId, "editor");

    const upd = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: g.cookie,
      payload: { baseVersion: s.version, content: "# guest edit\n" },
    });
    expect(upd.statusCode).toBe(200);
  });
});

describe("Phase B membership administration", () => {
  it("admins can create users with viewer or guest workspace roles", async () => {
    const s = await baseScenario();
    const v = await req({
      method: "POST",
      url: "/api/users",
      cookies: s.adminCookie,
      payload: {
        workspaceId: s.ws.id,
        email: "viewer-admin@t.co",
        name: "Viewer",
        password: "ChangeMe-12345678",
        role: "viewer",
      },
    });
    expect(v.statusCode).toBe(201);
    expect(v.json().role).toBe("viewer");

    const g = await req({
      method: "POST",
      url: "/api/users",
      cookies: s.adminCookie,
      payload: {
        workspaceId: s.ws.id,
        email: "guest-admin@t.co",
        name: "Guest",
        password: "ChangeMe-12345678",
        role: "guest",
      },
    });
    expect(g.statusCode).toBe(201);
    expect(g.json().role).toBe("guest");
  });

  it("an unknown role falls back to member (default behavior)", async () => {
    const s = await baseScenario();
    const res = await req({
      method: "POST",
      url: "/api/users",
      cookies: s.adminCookie,
      payload: {
        workspaceId: s.ws.id,
        email: "bogus@t.co",
        name: "Bogus",
        password: "ChangeMe-12345678",
        role: "manager", // not a workspace role
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("member");
  });
});
