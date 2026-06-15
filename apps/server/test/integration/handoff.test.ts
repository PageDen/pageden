import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const HANDOFF_DOC = `---
status: canonical
---

# Migration Plan

This plan describes how we migrate the workspace search to the new ranking. The change touches the api contract.

## Phase 1: backfill

- Backfill canonical status on all rows
- Update the search ORDER BY
- Update the api-contract documentation

## Acceptance Criteria

- All existing tests pass
- Search returns canonical results first

## Tests

- pnpm test

## Non-goals

- Refactoring the search snippet builder

## Open Questions

- Should drafts also rank above superseded? Blocking.

## Related Files

The implementation touches \`apps/server/src/documents/routes.ts\`.
`;

async function setupHandoffDoc() {
  const s = await baseScenario();
  const put = await req({
    method: "PUT",
    url: `/api/documents/${s.docId}`,
    cookies: s.adminCookie,
    payload: { baseVersion: s.version, content: HANDOFF_DOC, title: "Migration Plan" },
  });
  if (put.statusCode !== 200) throw new Error(`fixture handoff put failed: ${put.body}`);
  return { ...s, version: put.json().version as string };
}

async function agentToken(scopes: string[] = ["search", "read", "create", "update", "append"]) {
  const s = await setupHandoffDoc();
  const created = await req({
    method: "POST",
    url: "/api/tokens",
    cookies: s.adminCookie,
    payload: { name: "Test agent", kind: "agent", workspaceId: s.ws.id, scopes },
  });
  expect(created.statusCode).toBe(201);
  return { ...s, token: created.json().token as string };
}

describe("handoff packet endpoint", () => {
  it("returns a structured task packet for a canonical document", async () => {
    const s = await setupHandoffDoc();
    const res = await req({ method: "GET", url: `/api/documents/${s.docId}/handoff`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe(s.docId);
    expect(body.path).toBe("engineering/runbook.md");
    expect(body.packet.summary).toMatch(/migrate the workspace search/);
    expect(body.packet.currentPhase).toBe("Phase 1: backfill");
    expect(body.packet.acceptanceCriteria).toContain("Search returns canonical results first");
    expect(body.packet.tests).toContain("pnpm test");
    expect(body.packet.nonGoals).toContain("Refactoring the search snippet builder");
    expect(body.packet.openQuestions[0]).toMatch(/Should drafts/);
    expect(body.packet.relatedFiles).toContain("apps/server/src/documents/routes.ts");
    expect(body.packet.implementationReadiness.status).toBe("has_blocking_questions");
  });

  it("404s when the document is missing", async () => {
    const s = await setupHandoffDoc();
    const res = await req({ method: "GET", url: "/api/documents/does-not-exist/handoff", cookies: s.adminCookie });
    expect(res.statusCode).toBe(404);
  });

  it("hides the packet from users who lack read access", async () => {
    const s = await setupHandoffDoc();
    const stranger = await prisma.user.create({ data: { email: "stranger@t.co", name: "S", passwordHash: "x" } });
    const strangerCookie = sessionFor(stranger.id);
    const res = await req({ method: "GET", url: `/api/documents/${s.docId}/handoff`, cookies: strangerCookie });
    expect(res.statusCode).toBe(404);
  });
});

describe("implementationReadiness on GET /api/documents/:id", () => {
  it("includes implementationReadiness with the same status as the handoff packet", async () => {
    const s = await setupHandoffDoc();
    const res = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.implementationReadiness).toBeTruthy();
    expect(body.implementationReadiness.status).toBe("has_blocking_questions");
    expect(body.status).toBe("canonical");
  });
});

describe("MCP handoff tools", () => {
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

  it("pageden_read_section returns just the requested section", async () => {
    const s = await agentToken();
    const res = await tool(s.token, "pageden_read_section", { documentId: s.docId, heading: "acceptance-criteria" });
    expect(res.statusCode).toBe(200);
    const body = toolJson(res);
    expect(body.section.heading).toBe("Acceptance Criteria");
    expect(body.section.content).toMatch(/Search returns canonical results first/);
  });

  it("pageden_read_section returns availableHeadings when the heading is unknown", async () => {
    const s = await agentToken();
    const res = await tool(s.token, "pageden_read_section", { documentId: s.docId, heading: "no-such-section" });
    expect(res.statusCode).toBe(200);
    const body = toolJson(res);
    expect(body.section).toBeNull();
    expect(body.availableHeadings.map((h: { anchor: string }) => h.anchor)).toContain("acceptance-criteria");
  });

  it("pageden_get_task_packet returns the same shape as the REST endpoint", async () => {
    const s = await agentToken();
    const res = await tool(s.token, "pageden_get_task_packet", { documentId: s.docId });
    expect(res.statusCode).toBe(200);
    const body = toolJson(res);
    expect(body.documentId).toBe(s.docId);
    expect(body.packet.implementationReadiness.status).toBe("has_blocking_questions");
    expect(body.packet.acceptanceCriteria).toContain("Search returns canonical results first");
  });

  it("pageden_get_task_packet resolves by path when documentId is omitted", async () => {
    const s = await agentToken();
    const res = await tool(s.token, "pageden_get_task_packet", { path: "engineering/runbook.md" });
    expect(res.statusCode).toBe(200);
    expect(toolJson(res).documentId).toBe(s.docId);
  });

  it("pageden_get_task_packet errors when neither documentId nor path is provided", async () => {
    const s = await agentToken();
    const res = await tool(s.token, "pageden_get_task_packet", {});
    expect(res.statusCode).toBe(200);
    // Tool errors come back as a JSON-RPC error, not a tool result.
    expect(res.json().error.message).toMatch(/documentId or path/i);
  });
});
