import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeApp, getApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createWorkspace, member } from "../fixtures/seed.js";
import { pruneAuditEvents } from "../../src/workspaces/audit-log.js";

beforeAll(async () => {
  await getApp();
});
afterAll(async () => {
  await closeApp();
  await prisma.$disconnect();
});
beforeEach(async () => {
  process.env.CLOUD_HOSTED = "true";
  await resetDb();
});
afterEach(() => {
  delete process.env.CLOUD_HOSTED;
});

describe("cloud audit log", () => {
  it("lists workspace-scoped events with redacted metadata; excludes other-ws and null-ws", async () => {
    const s = await baseScenario();
    const other = await createWorkspace("Other", "other");
    await prisma.auditEvent.create({
      data: { workspaceId: s.ws.id, userId: s.admin.id, action: "permission_added", targetType: "document", targetId: "d1", metadata: { tokenHash: "secret", role: "editor" } },
    });
    await prisma.auditEvent.create({ data: { workspaceId: other.id, action: "permission_added", targetType: "document", targetId: "x" } });
    await prisma.auditEvent.create({ data: { workspaceId: null, userId: s.admin.id, action: "login_succeeded", targetType: "user", targetId: s.admin.id } });

    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit?action=permission_added`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const events = res.json().events as Array<{ action: string; actor: { email: string } | null; metadata: Record<string, unknown> | null }>;
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("permission_added");
    expect(events[0].metadata?.tokenHash).toBe("[redacted]");
    expect(events[0].metadata?.role).toBe("editor");
    expect(events[0].actor?.email).toBe("admin@t.co");
  });

  it("404s for non-admins and when cloud is disabled", async () => {
    const s = await baseScenario();
    const m = await member(s.ws.id, "member@t.co", "member");
    expect((await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit`, cookies: m.cookie })).statusCode).toBe(404);

    delete process.env.CLOUD_HOSTED;
    expect((await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit`, cookies: s.adminCookie })).statusCode).toBe(404);
  });

  it("exports CSV with attachment headers", async () => {
    const s = await baseScenario();
    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit/export?format=csv`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(String(res.body).split("\n")[0]).toContain("createdAt,action");
  });

  it("exports JSON and rejects unknown formats", async () => {
    const s = await baseScenario();
    const json = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit/export?format=json`, cookies: s.adminCookie });
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-type"]).toContain("application/json");
    expect(json.headers["content-disposition"]).toContain(".json");
    expect(Array.isArray(json.json().events)).toBe(true);
    const bad = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit/export?format=xml`, cookies: s.adminCookie });
    expect(bad.statusCode).toBe(400);
  });

  it("rejects an invalid date filter", async () => {
    const s = await baseScenario();
    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit?from=notadate`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(400);
  });

  it("validates + persists retention and prunes only older events", async () => {
    const s = await baseScenario();
    expect(
      (await req({ method: "PUT", url: `/api/workspaces/${s.ws.id}/settings/audit-retention`, cookies: s.adminCookie, payload: { auditRetentionDays: 4000 } })).statusCode,
    ).toBe(400);
    const ok = await req({ method: "PUT", url: `/api/workspaces/${s.ws.id}/settings/audit-retention`, cookies: s.adminCookie, payload: { auditRetentionDays: 30 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().auditRetentionDays).toBe(30);

    const old = await prisma.auditEvent.create({
      data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "old", createdAt: new Date(Date.now() - 100 * 864e5) },
    });
    const recent = await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "recent" } });

    await pruneAuditEvents();
    expect(await prisma.auditEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.auditEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it("operator AUDIT_MAX_RETENTION_DAYS overrides per-workspace 'keep forever'", async () => {
    const s = await baseScenario();
    // Workspace opts out of pruning...
    await prisma.workspace.update({ where: { id: s.ws.id }, data: { auditRetentionDays: 0 } });
    const old = await prisma.auditEvent.create({
      data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "old", createdAt: new Date(Date.now() - 100 * 864e5) },
    });
    // ...but the operator cap forces a 30-day ceiling.
    process.env.AUDIT_MAX_RETENTION_DAYS = "30";
    try {
      await pruneAuditEvents();
      expect(await prisma.auditEvent.findUnique({ where: { id: old.id } })).toBeNull();
    } finally {
      delete process.env.AUDIT_MAX_RETENTION_DAYS;
    }
  });

  it("canViewAudit member can view + export but not change retention or grant access", async () => {
    const s = await baseScenario();
    const m = await member(s.ws.id, "viewer@t.co", "member");
    // Before grant: no access.
    expect((await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit`, cookies: m.cookie })).statusCode).toBe(404);

    const grant = await req({
      method: "PUT",
      url: `/api/workspaces/${s.ws.id}/members/${m.user.id}/audit-access`,
      cookies: s.adminCookie,
      payload: { canViewAudit: true },
    });
    expect(grant.statusCode).toBe(200);

    // Now can view + export.
    expect((await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit`, cookies: m.cookie })).statusCode).toBe(200);
    expect((await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit/export?format=csv`, cookies: m.cookie })).statusCode).toBe(200);

    // But cannot change retention (admin-only) or grant access to others.
    expect(
      (await req({ method: "PUT", url: `/api/workspaces/${s.ws.id}/settings/audit-retention`, cookies: m.cookie, payload: { auditRetentionDays: 30 } })).statusCode,
    ).toBe(404);
    const other = await member(s.ws.id, "other@t.co", "member");
    expect(
      (await req({ method: "PUT", url: `/api/workspaces/${s.ws.id}/members/${other.user.id}/audit-access`, cookies: m.cookie, payload: { canViewAudit: true } })).statusCode,
    ).toBe(403);
  });
});
