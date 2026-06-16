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

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await req({
    method: "POST",
    url: "/mcp",
    headers: bearer(token),
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  if (res.statusCode !== 200) throw new Error(`${name} failed: ${res.body}`);
  return JSON.parse(res.json().result.content[0].text);
}

async function agentToken(workspaceId: string, adminCookie: Record<string, string>, scopes = ["search", "read", "update"]) {
  const res = await req({
    method: "POST",
    url: "/api/tokens",
    cookies: adminCookie,
    payload: { name: "Hygiene agent", kind: "agent", workspaceId, scopes },
  });
  if (res.statusCode !== 201) throw new Error(`token failed: ${res.body}`);
  return res.json().token as string;
}

describe("pageden_lint_wikilinks (F12)", () => {
  it("reports broken wikilinks across the workspace with attempts + suggestion", async () => {
    const s = await baseScenario();
    await makeDoc(s.adminCookie, s.ws.id, s.folderId, "real", "Real Doc", "# Real Doc\n");
    await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "subject",
      "Subject",
      `# Subject

This links to [[engineering/real]] (real) and [[Some-Old-Path]] (broken).
`,
    );
    const token = await agentToken(s.ws.id, s.adminCookie, ["search", "read"]);
    const result = await callTool(token, "pageden_lint_wikilinks");
    expect(result.brokenCount).toBe(1);
    expect(result.broken[0].brokenLink).toBe("Some-Old-Path");
    expect(Array.isArray(result.broken[0].attempts)).toBe(true);
    expect(result.broken[0].attempts.length).toBeGreaterThan(0);
    expect(typeof result.broken[0].explanation).toBe("string");
  });

  it("F13: resolves hyphen↔em-dash typographic differences", async () => {
    const s = await baseScenario();
    await makeDoc(s.adminCookie, s.ws.id, s.folderId, "deploy", "Deploy — Plan", "# Deploy — Plan\n");
    await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "ref",
      "Ref",
      "# Ref\n\nLink: [[Deploy - Plan]].\n", // hyphen, not em-dash
    );
    const token = await agentToken(s.ws.id, s.adminCookie, ["search", "read"]);
    const result = await callTool(token, "pageden_lint_wikilinks");
    // The hyphen-form link should fuzzy-resolve to the em-dash doc, so the
    // lint should report ZERO broken links.
    expect(result.brokenCount).toBe(0);
  });
});

describe("pageden_rewrite_wikilinks (F12)", () => {
  it("dryRun returns the per-doc occurrence count without writing", async () => {
    const s = await baseScenario();
    const target = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "new-home", "New Home", "# New Home\n");
    const subject = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "ref",
      "Ref",
      `# Ref

Old wikilinks [[Old-Home]] appear here once.
And here twice: [[Old-Home]].
`,
    );
    const token = await agentToken(s.ws.id, s.adminCookie);
    const dry = await callTool(token, "pageden_rewrite_wikilinks", {
      replacements: [{ from: "Old-Home", to: "engineering/new-home" }],
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    const entry = dry.changes.find((change: { documentId: string }) => change.documentId === subject.id);
    expect(entry.status).toBe("would_write");
    expect(entry.occurrences).toBe(2);

    // No write should have happened — verify the doc body still contains "Old-Home".
    const read = await req({ method: "GET", url: `/api/documents/${subject.id}`, cookies: s.adminCookie });
    expect(read.json().content).toContain("[[Old-Home]]");
    expect(target.id).toBeTruthy();
  });

  it("dryRun=false actually rewrites the matching docs and assigns a new version", async () => {
    const s = await baseScenario();
    const subject = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "ref",
      "Ref",
      `# Ref

[[Old-Home]] needs replacement.
`,
    );
    const token = await agentToken(s.ws.id, s.adminCookie);
    const live = await callTool(token, "pageden_rewrite_wikilinks", {
      replacements: [{ from: "Old-Home", to: "engineering/new-home" }],
      dryRun: false,
    });
    expect(live.dryRun).toBe(false);
    const entry = live.changes.find((change: { documentId: string }) => change.documentId === subject.id);
    expect(entry.status).toBe("written");
    expect(entry.newVersion).toBeTruthy();

    const read = await req({ method: "GET", url: `/api/documents/${subject.id}`, cookies: s.adminCookie });
    expect(read.json().content).not.toContain("[[Old-Home]]");
    expect(read.json().content).toContain("[[engineering/new-home]]");
  });

  it("defaults to dryRun=true when the caller omits the field", async () => {
    const s = await baseScenario();
    const subject = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "ref", "Ref", "# Ref\n[[Old]]\n");
    const token = await agentToken(s.ws.id, s.adminCookie);
    const result = await callTool(token, "pageden_rewrite_wikilinks", {
      replacements: [{ from: "Old", to: "engineering/new" }],
    });
    expect(result.dryRun).toBe(true);
    const read = await req({ method: "GET", url: `/api/documents/${subject.id}`, cookies: s.adminCookie });
    expect(read.json().content).toContain("[[Old]]");
  });
});
