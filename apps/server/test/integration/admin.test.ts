import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member, createUser, PW } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

describe("admin — users/groups/workspaces/audit", () => {
  it("lists workspaces for the current user", async () => {
    const s = await baseScenario();
    await prisma.workspace.update({
      where: { id: s.ws.id },
      data: { subdomain: "workspace", customDomain: "docs.example.com" },
    });
    const res = await req({ method: "GET", url: "/api/workspaces", cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces[0].id).toBe(s.ws.id);
    expect(res.json().workspaces[0].subdomain).toBe("workspace");
    expect(res.json().workspaces[0].customDomain).toBe("docs.example.com");
  });

  it("resolves the current workspace in self-hosted mode", async () => {
    const s = await baseScenario();
    const res = await req({ method: "GET", url: "/api/workspaces/current", cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace.id).toBe(s.ws.id);
    expect(res.json().routingMode).toBe("self_hosted");
  });

  it("resolves an explicit current workspace", async () => {
    const s = await baseScenario();
    const other = await prisma.workspace.create({ data: { name: "Other", slug: "other" } });
    await prisma.workspaceMembership.create({ data: { workspaceId: other.id, userId: s.admin.id, role: "admin" } });
    const res = await req({
      method: "GET",
      url: `/api/workspaces/current?workspaceId=${other.id}`,
      cookies: s.adminCookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace.id).toBe(other.id);
    expect(res.json().routingMode).toBe("explicit");
  });

  it("hides an explicit current workspace when the user is not a member", async () => {
    const s = await baseScenario();
    const other = await prisma.workspace.create({ data: { name: "Other", slug: "other" } });
    const res = await req({
      method: "GET",
      url: `/api/workspaces/current?workspaceId=${other.id}`,
      cookies: s.adminCookie,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("returns not_found for users with no current workspace", async () => {
    const user = await createUser("empty@t.co");
    const res = await req({ method: "GET", url: "/api/workspaces/current", cookies: sessionFor(user.id) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("only admins manage users; create requires valid fields", async () => {
    const s = await baseScenario();
    const { cookie } = await member(s.ws.id, "plain@t.co", "member");
    const denied = await req({ method: "GET", url: `/api/users?workspaceId=${s.ws.id}`, cookies: cookie });
    expect(denied.statusCode).toBe(403);

    const short = await req({ method: "POST", url: "/api/users", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, email: "new@t.co", name: "New", password: "short" } });
    expect(short.statusCode).toBe(400);
    expect(short.json().fields.password).toBeTruthy();

    const ok = await req({ method: "POST", url: "/api/users", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, email: "new@t.co", name: "New", password: PW, role: "member" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().email).toBe("new@t.co");
  });

  it("creates groups (admin), lists (member), manages membership", async () => {
    const s = await baseScenario();
    const m = await member(s.ws.id, "g@t.co", "member");
    const dupSlug = await req({ method: "POST", url: "/api/groups", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: "Eng", slug: "eng" } });
    expect(dupSlug.statusCode).toBe(201);
    const dup = await req({ method: "POST", url: "/api/groups", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: "Eng2", slug: "eng" } });
    expect(dup.statusCode).toBe(400);
    const groupId = dupSlug.json().id as string;

    const list = await req({ method: "GET", url: `/api/groups?workspaceId=${s.ws.id}`, cookies: m.cookie });
    expect(list.json().groups).toHaveLength(1);

    const add = await req({ method: "POST", url: `/api/groups/${groupId}/members`, cookies: s.adminCookie, payload: { userId: m.user.id } });
    expect(add.statusCode).toBe(201);
    const rm = await req({ method: "DELETE", url: `/api/groups/${groupId}/members/${m.user.id}`, cookies: s.adminCookie });
    expect(rm.statusCode).toBe(200);
  });

  it("audit: admin-only, paginates, rejects a bad limit", async () => {
    const s = await baseScenario();
    const all = await req({ method: "GET", url: `/api/audit?workspaceId=${s.ws.id}`, cookies: s.adminCookie });
    expect(all.statusCode).toBe(200);
    expect((all.json().events as unknown[]).length).toBeGreaterThan(0);

    const page = await req({ method: "GET", url: `/api/audit?workspaceId=${s.ws.id}&limit=1`, cookies: s.adminCookie });
    expect(page.json().events).toHaveLength(1);

    const bad = await req({ method: "GET", url: `/api/audit?workspaceId=${s.ws.id}&limit=abc`, cookies: s.adminCookie });
    expect(bad.statusCode).toBe(400);
    const frac = await req({ method: "GET", url: `/api/audit?workspaceId=${s.ws.id}&limit=2.9`, cookies: s.adminCookie });
    expect(frac.statusCode).toBe(400);
  });

  it("audit nextBefore cursor returns the next page without overlap", async () => {
    const s = await baseScenario();
    // generate more events
    for (let i = 0; i < 4; i++) {
      await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: `F${i}`, slug: `f${i}` } });
    }
    const p1 = await req({ method: "GET", url: `/api/audit?workspaceId=${s.ws.id}&limit=2`, cookies: s.adminCookie });
    expect(p1.json().events).toHaveLength(2);
    const cursor = p1.json().nextBefore as string;
    expect(cursor).toBeTruthy();
    const p2 = await req({ method: "GET", url: `/api/audit?workspaceId=${s.ws.id}&limit=2&before=${cursor}`, cookies: s.adminCookie });
    const ids1 = (p1.json().events as Array<{ id: string }>).map((e) => e.id);
    const ids2 = (p2.json().events as Array<{ id: string }>).map((e) => e.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("rejects adding a non-member to a group", async () => {
    const s = await baseScenario();
    const g = await req({ method: "POST", url: "/api/groups", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, name: "G", slug: "g" } });
    const outsider = await createUser("outsider@t.co"); // not a member of s.ws
    const res = await req({ method: "POST", url: `/api/groups/${g.json().id}/members`, cookies: s.adminCookie, payload: { userId: outsider.id } });
    expect(res.statusCode).toBe(400);
  });
});
