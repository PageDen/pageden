import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeApp, getApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createWorkspace, member } from "../fixtures/seed.js";
import { pruneAuditEvents, createAuditCheckpoint, verifyAuditChain } from "../../src/workspaces/audit-log.js";

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

  it("account-activity returns only the caller's own events across all workspaces + null-ws", async () => {
    const s = await baseScenario();
    const other = await createWorkspace("Other", "other");
    // Admin's own events: one workspace-scoped, one account-level (workspaceId=null).
    await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, userId: s.admin.id, action: "token_created", targetType: "token", targetId: "t1" } });
    await prisma.auditEvent.create({ data: { workspaceId: null, userId: s.admin.id, action: "login_succeeded", targetType: "user", targetId: s.admin.id, metadata: { sessionToken: "secret" } } });
    // Someone else's event, and an event in another workspace by another actor.
    const m = await member(s.ws.id, "member@t.co", "member");
    await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, userId: m.user.id, action: "token_created", targetType: "token", targetId: "t2" } });
    await prisma.auditEvent.create({ data: { workspaceId: other.id, userId: null, action: "document_updated", targetType: "document", targetId: "x" } });

    const res = await req({ method: "GET", url: "/api/me/account-activity", cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const events = res.json().events as Array<{ action: string; targetId: string | null; actor: { id: string } | null; metadata: Record<string, unknown> | null }>;
    // Every returned event belongs to the caller (across all workspaces + null-ws)...
    expect(events.every((e) => e.actor?.id === s.admin.id)).toBe(true);
    const targets = events.map((e) => e.targetId);
    expect(targets).toContain("t1"); // own workspace-scoped event
    expect(targets).not.toContain("t2"); // ...never another user's event
    expect(events.some((e) => e.action === "login_succeeded")).toBe(true); // account-level (workspaceId=null) included
    // Redaction still applies.
    expect(events.find((e) => e.action === "login_succeeded")?.metadata?.sessionToken).toBe("[redacted]");

    // A different user only sees their own.
    const mine = await req({ method: "GET", url: "/api/me/account-activity", cookies: m.cookie });
    expect(mine.statusCode).toBe(200);
    const mineEvents = mine.json().events as Array<{ targetId: string | null; actor: { id: string } | null }>;
    expect(mineEvents.every((e) => e.actor?.id === m.user.id)).toBe(true);
    expect(mineEvents.map((e) => e.targetId)).toContain("t2");
    expect(mineEvents.map((e) => e.targetId)).not.toContain("t1");
  });

  it("account-activity 404s when cloud is disabled", async () => {
    const s = await baseScenario();
    delete process.env.CLOUD_HOSTED;
    expect((await req({ method: "GET", url: "/api/me/account-activity", cookies: s.adminCookie })).statusCode).toBe(404);
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

describe("audit tamper-evidence (signed checkpoints)", () => {
  it("seals events and verifies an intact chain across multiple checkpoints", async () => {
    const s = await baseScenario();
    await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "a", metadata: { n: 1 } } });
    const cp1 = await createAuditCheckpoint();
    expect(cp1).not.toBeNull();
    // A second batch + checkpoint, to exercise the chain link.
    await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "b" } });
    const cp2 = await createAuditCheckpoint();
    expect(cp2).not.toBeNull();
    // No new events → no checkpoint created.
    expect(await createAuditCheckpoint()).toBeNull();

    const v = await verifyAuditChain();
    expect(v.ok).toBe(true);
    expect(v.checkpoints).toBe(2);
    expect(v.verified).toBe(2);
    expect(v.pendingCount).toBe(0);
  });

  it("detects in-place modification of a sealed event", async () => {
    const s = await baseScenario();
    const ev = await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "permission_added", targetType: "document", targetId: "d1", metadata: { role: "viewer" } } });
    await createAuditCheckpoint();
    expect((await verifyAuditChain()).ok).toBe(true);

    // Tamper: silently change the stored action.
    await prisma.auditEvent.update({ where: { id: ev.id }, data: { action: "permission_removed" } });
    const v = await verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.brokenCheckpointId).not.toBeNull();
  });

  it("detects an event inserted into an already-sealed range", async () => {
    const s = await baseScenario();
    const e1 = await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "x", createdAt: new Date(Date.now() - 60_000) } });
    await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "y" } });
    await createAuditCheckpoint();
    // Backdate an injected event into the sealed window.
    await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "z", createdAt: new Date(e1.createdAt.getTime() + 1000) } });
    const v = await verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.brokenCheckpointId).not.toBeNull();
  });

  it("admin can seal + verify via the API; non-admins and self-hosted 404", async () => {
    const s = await baseScenario();
    await prisma.auditEvent.create({ data: { workspaceId: s.ws.id, action: "document_updated", targetType: "document", targetId: "a" } });

    const seal = await req({ method: "POST", url: `/api/workspaces/${s.ws.id}/audit/checkpoint`, cookies: s.adminCookie });
    expect(seal.statusCode).toBe(200);
    expect(seal.json().created).toBe(true);

    const integrity = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit/integrity`, cookies: s.adminCookie });
    expect(integrity.statusCode).toBe(200);
    expect(integrity.json().ok).toBe(true);

    const m = await member(s.ws.id, "member@t.co", "member");
    expect((await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/audit/integrity`, cookies: m.cookie })).statusCode).toBe(404);

    delete process.env.CLOUD_HOSTED;
    expect((await req({ method: "POST", url: `/api/workspaces/${s.ws.id}/audit/checkpoint`, cookies: s.adminCookie })).statusCode).toBe(404);
  });
});
