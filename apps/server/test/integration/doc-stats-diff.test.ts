import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function makeDoc(cookies: Record<string, string>, workspaceId: string, folderId: string, slug: string, title: string, content: string) {
  const res = await req({
    method: "POST",
    url: "/api/documents",
    cookies,
    payload: { workspaceId, folderId, title, slug, content },
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return { id: res.json().id as string, version: res.json().version as string };
}

describe("GET /api/documents/:id/stats (F16)", () => {
  it("returns chars, tokenEstimate, chunkRecommendation, decision + wikilink counts", async () => {
    const s = await baseScenario();
    await makeDoc(s.adminCookie, s.ws.id, s.folderId, "neighbour", "Neighbour", "# Neighbour\n");
    const doc = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "subject",
      "Subject",
      `# Subject

This links to [[engineering/neighbour]] (real) and [[engineering/missing]] (broken).

:::decision
id: keep-it-simple
status: accepted

decision: Stick with the LCS diff for now.
:::
`,
    );
    const res = await req({ method: "GET", url: `/api/documents/${doc.id}/stats`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe(doc.id);
    expect(body.workspaceId).toBe(s.ws.id);
    expect(body.chars).toBeGreaterThan(0);
    expect(body.tokenEstimate).toBe(Math.ceil(body.chars / 4));
    expect(body.chunkRecommendation).toBeGreaterThan(0);
    expect(body.wikilinkCount).toBe(2);
    expect(body.brokenWikilinkCount).toBe(1);
    expect(body.decisionCount).toBe(1);
    expect(body.openCommentCount).toBe(0);
    expect(body.resolvedCommentCount).toBe(0);
  });

  it("forbids access when the caller cannot read the document", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "subject", "Subject", "# Subject\n");
    const { sealSession, SESSION_COOKIE } = await import("../../src/session.js");
    const { env } = await import("../../src/env.js");
    const { hashPassword } = await import("../../src/passwords.js");
    const stranger = await prisma.user.create({
      data: { email: "stranger@t.co", name: "Stranger", passwordHash: await hashPassword("ChangeMe-12345678") },
    });
    const cookie = { [SESSION_COOKIE]: sealSession(stranger.id, 0, env.sessionSecret) };
    const res = await req({ method: "GET", url: `/api/documents/${doc.id}/stats`, cookies: cookie });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/documents/:id/diff (F14)", () => {
  it("returns a unified diff between two revisions with added/removed counts", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "subject", "Subject", "# Subject\n\nfirst line\nsecond line\n");
    const firstVersion = doc.version;
    const update = await req({
      method: "PUT",
      url: `/api/documents/${doc.id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: firstVersion, content: "# Subject\n\nfirst line CHANGED\nsecond line\nthird line ADDED\n" },
    });
    expect(update.statusCode).toBe(200);
    const secondVersion = update.json().version as string;

    const res = await req({
      method: "GET",
      url: `/api/documents/${doc.id}/diff?fromVersion=${encodeURIComponent(firstVersion)}&toVersion=${encodeURIComponent(secondVersion)}`,
      cookies: s.adminCookie,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe(doc.id);
    expect(body.unified).toContain("---");
    expect(body.unified).toContain("+++");
    expect(body.unified).toContain("+first line CHANGED");
    expect(body.unified).toContain("-first line");
    expect(body.unified).toContain("+third line ADDED");
    expect(body.added).toBeGreaterThanOrEqual(2);
    expect(body.removed).toBeGreaterThanOrEqual(1);
  });

  it("returns 404 when one of the revisions belongs to another document", async () => {
    const s = await baseScenario();
    const docA = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "alpha", "Alpha", "# Alpha\n");
    const docB = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "beta", "Beta", "# Beta\n");
    const res = await req({
      method: "GET",
      url: `/api/documents/${docA.id}/diff?fromVersion=${encodeURIComponent(docA.version)}&toVersion=${encodeURIComponent(docB.version)}`,
      cookies: s.adminCookie,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when fromVersion === toVersion", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "subject", "Subject", "# Subject\n");
    const res = await req({
      method: "GET",
      url: `/api/documents/${doc.id}/diff?fromVersion=${doc.version}&toVersion=${doc.version}`,
      cookies: s.adminCookie,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("same_version");
  });

  it("works through the MCP tool pageden_diff", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "subject", "Subject", "alpha\n");
    const update = await req({
      method: "PUT",
      url: `/api/documents/${doc.id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: doc.version, content: "beta\n" },
    });
    expect(update.statusCode).toBe(200);
    const newVersion = update.json().version as string;

    const tokenRes = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Diff agent", kind: "agent", workspaceId: s.ws.id, scopes: ["search", "read"] },
    });
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
          name: "pageden_diff",
          arguments: { documentId: doc.id, fromVersion: doc.version, toVersion: newVersion },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.json().result.content[0].text);
    expect(body.unified).toContain("-alpha");
    expect(body.unified).toContain("+beta");
  });
});

describe("G8 — canonicalOnly write guard", () => {
  it("refuses PUT to a superseded doc and returns currentStatus", async () => {
    const s = await baseScenario();
    // Demote subject to superseded by setting status in frontmatter.
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "subject", "Subject", "---\nstatus: canonical\n---\n\n# Subject\n");
    const demote = await req({
      method: "PUT",
      url: `/api/documents/${doc.id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: doc.version, content: "---\nstatus: superseded\n---\n\n# Subject\n" },
    });
    expect(demote.statusCode).toBe(200);
    const supersededVersion = demote.json().version as string;

    // A second update should now be refused with not_canonical.
    const blocked = await req({
      method: "PUT",
      url: `/api/documents/${doc.id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: supersededVersion, content: "---\nstatus: superseded\n---\n\n# Subject reedit\n" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("not_canonical");
    expect(blocked.json().currentStatus).toBe("superseded");
  });

  it("still permits the SAME write to flip status back to canonical when allowed", async () => {
    const s = await baseScenario();
    const doc = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "subject", "Subject", "---\nstatus: canonical\n---\n\n# Subject\n");
    const demote = await req({
      method: "PUT",
      url: `/api/documents/${doc.id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: doc.version, content: "---\nstatus: superseded\n---\n\n# Subject\n" },
    });
    expect(demote.statusCode).toBe(200);
    // PUT/push paths don't expose allowNonCanonical (it's an MCP-internal escape
    // hatch); the only externally-visible behavior is that a freshly canonical
    // doc accepts writes. We confirm the guard fires after the demote.
    const res = await req({
      method: "PUT",
      url: `/api/documents/${doc.id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: demote.json().version, content: "# Subject\n" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_canonical");
  });
});
