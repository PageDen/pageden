import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const SAMPLE = `# Plan

Intro prose.

## Goals

- ship feature 11
- ship feature 17

## Acceptance Criteria

- replace_section works
- conflict detection works

## Notes

Trailing notes.
`;

async function makeDoc(cookies: Record<string, string>, workspaceId: string, folderId: string, body: string) {
  const res = await req({
    method: "POST",
    url: "/api/documents",
    cookies,
    payload: { workspaceId, folderId, title: "Plan", slug: "plan", content: body },
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return { id: res.json().id as string, version: res.json().version as string };
}

describe("POST /api/documents/:id/sections", () => {
  it("replaces a section by anchor and returns the new version + latestChangedSection", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, SAMPLE);

    const res = await req({
      method: "POST",
      url: `/api/documents/${doc.id}/sections`,
      cookies: s.adminCookie,
      payload: {
        anchor: "acceptance-criteria",
        baseVersion: doc.version,
        content: "- shipped\n- documented\n",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().latestChangedSection.anchor).toBe("acceptance-criteria");
    expect(res.json().version).not.toBe(doc.version);

    const read = await req({ method: "GET", url: `/api/documents/${doc.id}`, cookies: s.adminCookie });
    const content = read.json().content as string;
    expect(content).toContain("## Acceptance Criteria");
    expect(content).toContain("- shipped");
    expect(content).toContain("- documented");
    // Other sections untouched.
    expect(content).toContain("- ship feature 11");
    expect(content).toContain("Trailing notes.");
    // Old content is gone.
    expect(content).not.toContain("replace_section works");
  });

  it("returns anchor_not_found with candidate anchors when the heading does not exist", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, SAMPLE);

    const res = await req({
      method: "POST",
      url: `/api/documents/${doc.id}/sections`,
      cookies: s.adminCookie,
      payload: {
        anchor: "decisons", // typo for "decisions" — and decisions doesn't even exist
        baseVersion: doc.version,
        content: "anything",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("anchor_not_found");
    expect(Array.isArray(res.json().suggested)).toBe(true);
    // The four real anchors should still be reachable through the suggested
    // list when nothing scored above zero on the typo.
    expect(res.json().suggested.length).toBeGreaterThan(0);
  });

  it("returns 409 conflict when baseVersion is stale", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, SAMPLE);

    // First write moves the document forward.
    const first = await req({
      method: "POST",
      url: `/api/documents/${doc.id}/sections`,
      cookies: s.adminCookie,
      payload: { anchor: "goals", baseVersion: doc.version, content: "- updated\n" },
    });
    expect(first.statusCode).toBe(200);

    // Second write using the original (now-stale) baseVersion should 409.
    const stale = await req({
      method: "POST",
      url: `/api/documents/${doc.id}/sections`,
      cookies: s.adminCookie,
      payload: { anchor: "notes", baseVersion: doc.version, content: "stale\n" },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("requires editor role on the document (viewers get 403)", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, SAMPLE);

    const tokenRes = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Reader", kind: "agent", workspaceId: s.ws.id, scopes: ["search", "read"] },
    });
    expect(tokenRes.statusCode).toBe(201);
    const token = tokenRes.json().token as string;

    const res = await req({
      method: "POST",
      url: `/api/documents/${doc.id}/sections`,
      headers: bearer(token),
      payload: { anchor: "goals", baseVersion: doc.version, content: "x" },
    });
    // Token lacks the `update` scope so we get 403 before any auth check —
    // either way it must NOT write.
    expect([401, 403]).toContain(res.statusCode);
    const fresh = await req({ method: "GET", url: `/api/documents/${doc.id}`, cookies: s.adminCookie });
    expect(fresh.json().version).toBe(doc.version);
  });

  it("works through the MCP tool pageden_replace_section", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, SAMPLE);
    const tokenRes = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Editor", kind: "agent", workspaceId: s.ws.id, scopes: ["search", "read", "update"] },
    });
    expect(tokenRes.statusCode).toBe(201);
    const token = tokenRes.json().token as string;

    const res = await req({
      method: "POST",
      url: "/mcp",
      headers: bearer(token),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pageden_replace_section",
          arguments: {
            documentId: doc.id,
            anchor: "Notes", // pass the heading text, anchor or text both work
            content: "All decisions captured.\n",
            baseVersion: doc.version,
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.json().result.content[0].text);
    expect(body.documentId).toBe(doc.id);
    expect(body.latestChangedSection.anchor).toBe("notes");

    const fresh = await req({ method: "GET", url: `/api/documents/${doc.id}`, cookies: s.adminCookie });
    expect(fresh.json().content).toContain("All decisions captured.");
  });

  it("adds a structured decision through the REST endpoint with duplicate-id validation", async () => {
    const s = await baseScenario();
    const draft = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "---\nstatus: draft\nworkflow: multi-agent-planning\nworkflowStatus: final-review\nreviewRound: 1\n---\n\n# Draft Plan\n\n## Decisions\n",
    );

    const blocked = await req({
      method: "POST",
      url: `/api/documents/${draft.id}/decisions`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: draft.version,
        id: "final-plan",
        status: "accepted",
        owner: "agent-a",
        decision: "Use the reviewed plan.",
        reason: "Comments are resolved.",
      },
    });
    expect(blocked.statusCode).toBe(409);

    const added = await req({
      method: "POST",
      url: `/api/documents/${draft.id}/decisions`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: draft.version,
        allowDraft: true,
        id: "final-plan",
        status: "accepted",
        owner: "agent-a",
        decision: "Use the reviewed plan.",
        reason: "Comments are resolved.",
      },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().decision.id).toBe("final-plan");
    expect(added.json().decision.status).toBe("accepted");

    const duplicate = await req({
      method: "POST",
      url: `/api/documents/${draft.id}/decisions`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: added.json().version,
        allowDraft: true,
        id: "final-plan",
        status: "accepted",
        owner: "agent-a",
        decision: "Use the reviewed plan.",
        reason: "Comments are resolved.",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("duplicate_decision");

    const fresh = await req({ method: "GET", url: `/api/documents/${draft.id}`, cookies: s.adminCookie });
    expect(fresh.json().content).toContain(":::decision");
    expect(fresh.json().content).toContain("id: final-plan");
  });

  it("adds a structured decision through the MCP tool pageden_add_decision", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, `${SAMPLE}\n## Decisions\n`);
    const tokenRes = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Editor", kind: "agent", workspaceId: s.ws.id, scopes: ["search", "read", "update"] },
    });
    expect(tokenRes.statusCode).toBe(201);
    const token = tokenRes.json().token as string;

    const res = await req({
      method: "POST",
      url: "/mcp",
      headers: bearer(token),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pageden_add_decision",
          arguments: {
            documentId: doc.id,
            baseVersion: doc.version,
            id: "storage-choice",
            status: "accepted",
            owner: "agent-a",
            decision: "Keep decisions in structured Markdown blocks.",
            reason: "Agents and the UI can parse the same source of truth.",
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.json().result.content[0].text);
    expect(body.documentId).toBe(doc.id);
    expect(body.decision.id).toBe("storage-choice");
    expect(body.latestChangedSection.anchor).toBe("decisions");

    const fresh = await req({ method: "GET", url: `/api/documents/${doc.id}`, cookies: s.adminCookie });
    expect(fresh.json().content).toContain("id: storage-choice");
  });

  it("allows full-document web updates for drafts only when allowDraft is explicit", async () => {
    const s = await baseScenario();
    const draft = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "---\nstatus: draft\nworkflow: multi-agent-planning\nworkflowStatus: review\nreviewRound: 1\n---\n\n# Draft Plan\n",
    );

    const blocked = await req({
      method: "PUT",
      url: `/api/documents/${draft.id}`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: draft.version,
        content: "---\nstatus: draft\nworkflow: multi-agent-planning\nworkflowStatus: revision\nreviewRound: 1\n---\n\n# Draft Plan\n",
      },
    });
    expect(blocked.statusCode).toBe(409);

    const updated = await req({
      method: "PUT",
      url: `/api/documents/${draft.id}`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: draft.version,
        allowDraft: true,
        content: "---\nstatus: draft\nworkflow: multi-agent-planning\nworkflowStatus: revision\nreviewRound: 1\n---\n\n# Draft Plan\n",
      },
    });
    expect(updated.statusCode).toBe(200);

    const supersededRes = await req({
      method: "POST",
      url: "/api/documents",
      cookies: s.adminCookie,
      payload: {
        workspaceId: s.ws.id,
        folderId: s.folderId,
        title: "Superseded Plan",
        slug: "superseded-plan",
        content: "---\nstatus: superseded\n---\n\n# Superseded Plan\n",
      },
    });
    expect(supersededRes.statusCode).toBe(201);
    const superseded = { id: supersededRes.json().id as string, version: supersededRes.json().version as string };
    const rejected = await req({
      method: "PUT",
      url: `/api/documents/${superseded.id}`,
      cookies: s.adminCookie,
      payload: {
        baseVersion: superseded.version,
        allowDraft: true,
        content: "---\nstatus: superseded\n---\n\n# Still Superseded\n",
      },
    });
    expect(rejected.statusCode).toBe(409);
  });
});
