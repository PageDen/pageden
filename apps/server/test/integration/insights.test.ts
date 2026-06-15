import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function withSomeActivity() {
  const s = await baseScenario();
  // Two more edits + one fresh document so the dashboard and activity feed have
  // real audit rows to surface (instead of "no activity yet").
  const second = await req({
    method: "POST",
    url: "/api/documents",
    cookies: s.adminCookie,
    payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "Plan", slug: "plan", content: "# Plan\n" },
  });
  expect(second.statusCode).toBe(201);
  const put = await req({
    method: "PUT",
    url: `/api/documents/${s.docId}`,
    cookies: s.adminCookie,
    payload: { baseVersion: s.version, content: "# Runbook v2\n" },
  });
  expect(put.statusCode).toBe(200);
  return { ...s, planId: second.json().id as string };
}

describe("GET /api/workspaces/:workspaceId/activity", () => {
  it("returns document-related events for a workspace member", async () => {
    const s = await withSomeActivity();
    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/activity`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaceId).toBe(s.ws.id);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    const actions = body.events.map((e: { action: string }) => e.action);
    expect(actions).toContain("document_updated");
    expect(actions).toContain("document_created");
    const updateEvent = body.events.find((e: { action: string }) => e.action === "document_updated");
    expect(updateEvent.actor).toBe("user");
    expect(updateEvent.documentTitle).toBeTruthy();
  });

  it("404s for non-members", async () => {
    const s = await withSomeActivity();
    const stranger = await createUser("stranger@t.co", "S");
    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/activity`, cookies: sessionFor(stranger.id) });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an invalid before timestamp", async () => {
    const s = await withSomeActivity();
    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/activity?before=not-a-date`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.before).toBeTruthy();
  });

  it("paginates with limit + nextBefore", async () => {
    const s = await withSomeActivity();
    const first = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/activity?limit=1`, cookies: s.adminCookie });
    expect(first.statusCode).toBe(200);
    expect(first.json().events).toHaveLength(1);
    expect(first.json().nextBefore).toBeTruthy();

    const next = await req({
      method: "GET",
      url: `/api/workspaces/${s.ws.id}/activity?limit=1&before=${encodeURIComponent(first.json().nextBefore)}`,
      cookies: s.adminCookie,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().events[0].id).not.toBe(first.json().events[0].id);
  });
});

describe("GET /api/workspaces/:workspaceId/dashboard", () => {
  it("returns status counts, top folders, recent changes, and recent activity", async () => {
    const s = await withSomeActivity();
    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/dashboard`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaceId).toBe(s.ws.id);
    expect(body.totals.documents).toBe(2);
    expect(body.statusCounts.canonical).toBe(2);
    expect(body.statusCounts.draft).toBe(0);
    expect(body.statusCounts.superseded).toBe(0);
    expect(body.statusCounts.archived).toBe(0);
    expect(body.recentChanges.length).toBeGreaterThan(0);
    expect(body.recentActivity.length).toBeGreaterThan(0);
    expect(body.topFolders[0].documentCount).toBe(2);
  });

  it("surfaces a superseded document with its replacement link", async () => {
    const s = await withSomeActivity();
    // Mark `Runbook` as superseded by `Plan` via frontmatter on a write.
    const put = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: (await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie })).json().version,
        content: "---\nstatus: superseded\nsupersededBy: engineering/plan.md\n---\n# Old runbook\n",
      },
    });
    expect(put.statusCode).toBe(200);

    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/dashboard`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.statusCounts.canonical).toBe(1);
    expect(body.statusCounts.superseded).toBe(1);
    expect(body.supersededDocs).toHaveLength(1);
    expect(body.supersededDocs[0].supersededBy.id).toBe(s.planId);
  });

  it("404s for non-members", async () => {
    const s = await withSomeActivity();
    const stranger = await createUser("stranger@t.co", "S");
    const res = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/dashboard`, cookies: sessionFor(stranger.id) });
    expect(res.statusCode).toBe(404);
  });
});

describe("pageden_activity_timeline MCP tool", () => {
  async function tool(token: string, name: string, args: Record<string, unknown>) {
    return req({
      method: "POST",
      url: "/mcp",
      headers: bearer(token),
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
  }
  function toolJson(response: Awaited<ReturnType<typeof tool>>) {
    return JSON.parse(response.json().result.content[0].text);
  }

  it("returns recent document events with actor labels", async () => {
    const s = await withSomeActivity();
    const created = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Activity agent", kind: "agent", workspaceId: s.ws.id, scopes: ["read"] },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    const res = await tool(token, "pageden_activity_timeline", { limit: 10 });
    expect(res.statusCode).toBe(200);
    const body = toolJson(res);
    expect(body.workspaceId).toBe(s.ws.id);
    expect(body.events.length).toBeGreaterThan(0);
    const actorVals = body.events.map((e: { actor: string }) => e.actor);
    expect(actorVals.every((a: string) => ["user", "agent", "obsidian_plugin", "system", "unknown"].includes(a))).toBe(true);
  });

  it("rejects an invalid before timestamp", async () => {
    const s = await withSomeActivity();
    const created = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Activity agent", kind: "agent", workspaceId: s.ws.id, scopes: ["read"] },
    });
    const token = created.json().token as string;
    const res = await tool(token, "pageden_activity_timeline", { before: "not-a-date" });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.message).toMatch(/ISO timestamp/i);
  });
});
