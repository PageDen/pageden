import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

describe("Folder.defaultRole floor (Phase A1)", () => {
  it("gives a non-granted workspace member the folder's defaultRole on documents", async () => {
    const s = await baseScenario();
    const other = await member(s.ws.id, "viewer@t.co", "member");
    // Without a default role the non-granted member sees nothing.
    const before = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: other.cookie });
    expect(before.statusCode).toBe(404);

    // Set defaultRole=viewer on the folder; the same member can now read.
    const set = await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: "viewer" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().defaultRole).toBe("viewer");

    const after = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: other.cookie });
    expect(after.statusCode).toBe(200);
    expect(after.json().permission).toBe("viewer");
    expect(after.json().capabilities).toMatchObject({ canView: true, canEdit: false, canManage: false, canShare: false, canComment: true });
  });

  it("explicit higher grants win over the default floor", async () => {
    const s = await baseScenario();
    const other = await member(s.ws.id, "ed@t.co", "member");
    await prisma.permission.create({
      data: {
        workspaceId: s.ws.id,
        userId: other.user.id,
        resourceType: "document",
        resourceId: s.docId,
        role: "manager",
      },
    });
    await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: "viewer" },
    });
    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: other.cookie });
    expect(read.json().permission).toBe("manager");
    expect(read.json().capabilities.canManage).toBe(true);
  });

  it("rejects defaultRole values that are not a PermissionRole", async () => {
    const s = await baseScenario();
    const bad = await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: "owner" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("requires manager role on the folder to set defaultRole", async () => {
    const s = await baseScenario();
    const other = await member(s.ws.id, "ed@t.co", "member");
    await prisma.permission.create({
      data: {
        workspaceId: s.ws.id,
        userId: other.user.id,
        resourceType: "folder",
        resourceId: s.folderId,
        role: "editor",
      },
    });
    const res = await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: other.cookie,
      payload: { defaultRole: "viewer" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("setting defaultRole = null restores private behavior", async () => {
    const s = await baseScenario();
    const other = await member(s.ws.id, "ed@t.co", "member");
    await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: "editor" },
    });
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: other.cookie })).statusCode).toBe(200);

    await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: null },
    });
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: other.cookie })).statusCode).toBe(404);
  });

  it("tree response surfaces defaultRole and per-document capabilities", async () => {
    const s = await baseScenario();
    await req({
      method: "PUT",
      url: `/api/folders/${s.folderId}/default-role`,
      cookies: s.adminCookie,
      payload: { defaultRole: "viewer" },
    });
    const tree = await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    const folder = tree.json().folders.find((f: { id: string; defaultRole: string | null }) => f.id === s.folderId);
    expect(folder.defaultRole).toBe("viewer");
    const doc = tree.json().documents[0];
    expect(doc.capabilities).toMatchObject({ canView: true, canEdit: true, canManage: true, canShare: true });
  });
});

describe("Permission XOR check constraint (Phase A3)", () => {
  it("rejects a Permission row with both userId and groupId set", async () => {
    const s = await baseScenario();
    const group = await prisma.group.create({ data: { workspaceId: s.ws.id, name: "G", slug: "g" } });
    await expect(
      prisma.permission.create({
        data: {
          workspaceId: s.ws.id,
          userId: s.admin.id,
          groupId: group.id,
          resourceType: "folder",
          resourceId: s.folderId,
          role: "viewer",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a Permission row with neither userId nor groupId set", async () => {
    const s = await baseScenario();
    await expect(
      prisma.permission.create({
        data: {
          workspaceId: s.ws.id,
          resourceType: "folder",
          resourceId: s.folderId,
          role: "viewer",
        },
      }),
    ).rejects.toThrow();
  });
});
