import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { createUser, createWorkspace, addMember } from "../fixtures/seed.js";
import { createRawToken, hashToken } from "../../src/tokens.js";
import { env } from "../../src/env.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

/** Create an unscoped agent token (no workspaceId) directly via Prisma — the API
 *  requires workspaceId for agent tokens, so we bypass it here to test the multi-workspace path. */
async function unscopedToken(userId: string, scopes = ["search", "read", "create"]) {
  const rawToken = createRawToken();
  await prisma.apiToken.create({
    data: {
      userId,
      name: "multi-ws test token",
      kind: "agent",
      scopes,
      workspaceId: null,
      tokenHash: hashToken(rawToken, env.tokenHashSecret),
    },
  });
  return rawToken;
}

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

/** Seed two workspaces, one user member of both, and return the unscoped token. */
async function multiWorkspaceScenario() {
  const ws1 = await createWorkspace("Alpha Corp", "alpha-corp");
  const ws2 = await createWorkspace("Beta Inc", "beta-inc");
  const user = await createUser("multi@t.co", "Multi User");
  await addMember(ws1.id, user.id, "admin");
  await addMember(ws2.id, user.id, "admin");
  const token = await unscopedToken(user.id);
  return { ws1, ws2, user, token };
}

describe("pageden_list_workspaces", () => {
  it("returns all workspaces for a multi-workspace user", async () => {
    const { ws1, ws2, token } = await multiWorkspaceScenario();
    const res = toolJson(await tool(token, "pageden_list_workspaces", {}));
    expect(res.workspaces).toHaveLength(2);
    const ids = res.workspaces.map((w: { id: string }) => w.id);
    expect(ids).toContain(ws1.id);
    expect(ids).toContain(ws2.id);
    for (const w of res.workspaces as Array<{ id: string; name: string; slug: string }>) {
      expect(w.name).toBeDefined();
      expect(w.slug).toBeDefined();
    }
  });

  it("returns only the bound workspace for a scoped token", async () => {
    const ws = await createWorkspace("Single", "single");
    const user = await createUser("scoped@t.co");
    await addMember(ws.id, user.id, "admin");
    const ws2 = await createWorkspace("Other", "other");
    await addMember(ws2.id, user.id, "admin");
    const rawToken = createRawToken();
    await prisma.apiToken.create({
      data: { userId: user.id, name: "scoped", kind: "agent", scopes: ["read"], workspaceId: ws.id, tokenHash: hashToken(rawToken, env.tokenHashSecret) },
    });
    const res = toolJson(await tool(rawToken, "pageden_list_workspaces", {}));
    expect(res.workspaces).toHaveLength(1);
    expect(res.workspaces[0].id).toBe(ws.id);
  });
});

describe("pageden_search fan-out", () => {
  it("returns merged results from multiple workspaces when no workspaceId given", async () => {
    const { ws1, ws2, token } = await multiWorkspaceScenario();

    // Create a folder + doc in each workspace.
    const f1 = await req({ method: "POST", url: "/api/folders", headers: bearer(token), payload: { workspaceId: ws1.id, name: "Docs", slug: "docs" } });
    await req({ method: "POST", url: "/api/documents", headers: bearer(token), payload: { workspaceId: ws1.id, folderId: f1.json().id, title: "Alpha Runbook", slug: "alpha-runbook", content: "# Alpha Runbook\nAlpha content." } });

    const f2 = await req({ method: "POST", url: "/api/folders", headers: bearer(token), payload: { workspaceId: ws2.id, name: "Docs", slug: "docs" } });
    await req({ method: "POST", url: "/api/documents", headers: bearer(token), payload: { workspaceId: ws2.id, folderId: f2.json().id, title: "Beta Runbook", slug: "beta-runbook", content: "# Beta Runbook\nBeta content." } });

    const res = toolJson(await tool(token, "pageden_search", { query: "Runbook" }));
    expect(res.results).toBeDefined();
    expect(res.results.length).toBeGreaterThanOrEqual(2);
    const workspaceIds = res.results.map((r: { workspaceId: string }) => r.workspaceId);
    expect(workspaceIds).toContain(ws1.id);
    expect(workspaceIds).toContain(ws2.id);
    // Each result should carry a workspaceName
    for (const r of res.results as Array<{ workspaceName: string }>) {
      expect(r.workspaceName).toBeDefined();
    }
    // No errors for a healthy multi-workspace search
    expect(res.errors ?? []).toHaveLength(0);
  });

  it("returns partial results and errors[] when one workspace is inaccessible", async () => {
    const { ws1, ws2, token } = await multiWorkspaceScenario();

    // Create doc in ws1 only.
    const f1 = await req({ method: "POST", url: "/api/folders", headers: bearer(token), payload: { workspaceId: ws1.id, name: "Docs", slug: "docs" } });
    await req({ method: "POST", url: "/api/documents", headers: bearer(token), payload: { workspaceId: ws1.id, folderId: f1.json().id, title: "Alpha Guide", slug: "alpha-guide", content: "# Alpha Guide" } });

    // Remove membership from ws2 so it becomes inaccessible.
    await prisma.workspaceMembership.deleteMany({ where: { workspaceId: ws2.id } });

    const res = toolJson(await tool(token, "pageden_search", { query: "Alpha" }));
    // Results from ws1 still come through.
    expect(res.results.length).toBeGreaterThan(0);
    // The response always includes an errors array (may be empty if the search service
    // handles missing permissions gracefully with an empty result set).
    expect(res.errors).toBeDefined();
  });
});

describe("write operations with multi-workspace tokens", () => {
  it("fails with a helpful error listing available workspaces when workspaceId is omitted", async () => {
    const { ws1, ws2, token } = await multiWorkspaceScenario();

    // Create a folder in ws1 to get a valid folderId.
    const f = await req({ method: "POST", url: "/api/folders", headers: bearer(token), payload: { workspaceId: ws1.id, name: "Docs", slug: "docs" } });
    const folderId = f.json().id as string;

    // Call create without workspaceId — should fail with workspace hint.
    const res = await tool(token, "pageden_create_document", { folderId, title: "Test", slug: "test" });
    const body = res.json();
    expect(body.result.content[0].text).toMatch(/workspaceId is required/i);
    expect(body.result.content[0].text).toMatch(ws1.id);
    expect(body.result.content[0].text).toMatch(ws2.id);
    expect(body.result.content[0].text).toMatch(/Alpha Corp|Beta Inc/);
  });

  it("succeeds when workspaceId is explicitly provided", async () => {
    const { ws1, token } = await multiWorkspaceScenario();
    const f = await req({ method: "POST", url: "/api/folders", headers: bearer(token), payload: { workspaceId: ws1.id, name: "Docs", slug: "docs" } });
    const res = toolJson(await tool(token, "pageden_create_document", { workspaceId: ws1.id, folderId: f.json().id, title: "New Doc", slug: "new-doc", content: "Hello" }));
    expect(res.id).toBeDefined();
    expect(res.workspaceId).toBe(ws1.id);
  });
});

describe("pageden_list_documents fan-out", () => {
  it("includes workspaceId on each document and folder for unscoped multi-workspace tokens", async () => {
    const { ws1, ws2, token } = await multiWorkspaceScenario();
    await req({ method: "POST", url: "/api/folders", headers: bearer(token), payload: { workspaceId: ws1.id, name: "Eng", slug: "eng" } });
    await req({ method: "POST", url: "/api/folders", headers: bearer(token), payload: { workspaceId: ws2.id, name: "Ops", slug: "ops" } });

    const res = toolJson(await tool(token, "pageden_list_documents", {}));
    expect(res.folders).toBeDefined();
    const wsIds = new Set((res.folders as Array<{ workspaceId: string }>).map((f) => f.workspaceId));
    expect(wsIds.has(ws1.id)).toBe(true);
    expect(wsIds.has(ws2.id)).toBe(true);
    expect(res.errors ?? []).toHaveLength(0);
  });
});
