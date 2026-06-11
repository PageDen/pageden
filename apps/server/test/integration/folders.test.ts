import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

describe("folders", () => {
  it("only workspace admins create root folders", async () => {
    const s = await baseScenario();
    const { cookie } = await member(s.ws.id, "m@t.co", "member");
    const denied = await req({ method: "POST", url: "/api/folders", cookies: cookie, payload: { workspaceId: s.ws.id, name: "Root", slug: "root" } });
    expect(denied.statusCode).toBe(403);
    const ok = await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: "Root", slug: "root" } });
    expect(ok.statusCode).toBe(201);
  });

  it("rejects invalid and duplicate sibling slugs", async () => {
    const s = await baseScenario();
    const bad = await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: "X", slug: "Bad Slug" } });
    expect(bad.statusCode).toBe(400);
    const dup = await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: "Dup", slug: "engineering" } });
    expect(dup.statusCode).toBe(400);
  });

  it("rename cascades descendant paths atomically", async () => {
    const s = await baseScenario();
    const sub = await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, parentFolderId: s.folderId, name: "Sub", slug: "sub" } });
    const subId = sub.json().id as string;
    const d = await req({ method: "POST", url: "/api/documents", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, folderId: subId, title: "Deep", slug: "deep", content: "x" } });
    const ren = await req({ method: "POST", url: `/api/folders/${s.folderId}/rename`, cookies: s.adminCookie, payload: { slug: "platform" } });
    expect(ren.statusCode).toBe(200);
    expect(ren.json().path).toBe("platform");
    const deep = await prisma.document.findUniqueOrThrow({ where: { id: d.json().id } });
    expect(deep.path).toBe("platform/sub/deep.md");
  });

  it("rejects moving a folder into its own subtree", async () => {
    const s = await baseScenario();
    const sub = await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, parentFolderId: s.folderId, name: "Sub", slug: "sub" } });
    const res = await req({ method: "POST", url: `/api/folders/${s.folderId}/move`, cookies: s.adminCookie, payload: { parentFolderId: sub.json().id } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
  });

  it("refuses to delete a non-empty folder, allows after emptying", async () => {
    const s = await baseScenario();
    const nonEmpty = await req({ method: "DELETE", url: `/api/folders/${s.folderId}`, cookies: s.adminCookie });
    expect(nonEmpty.statusCode).toBe(400);
    await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    const empty = await req({ method: "DELETE", url: `/api/folders/${s.folderId}`, cookies: s.adminCookie });
    expect(empty.statusCode).toBe(200);
  });
});
