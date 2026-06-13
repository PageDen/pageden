import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, grant } from "../fixtures/seed.js";

const HL_START = "\uE000";
const HL_STOP = "\uE001";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function createDoc(ws: string, folderId: string, cookie: Record<string, string>, slug: string, title: string, content: string) {
  const r = await req({ method: "POST", url: "/api/documents", cookies: cookie, payload: { workspaceId: ws, folderId, title, slug, content } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

describe("full-text search", () => {
  it("matches content and title, permission-filtered, ranked", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "alpha", "Alpha", "the quick brown zorptastic fox");
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "beta", "Beta runbook", "nothing special here");

    const hit = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: s.adminCookie });
    expect(hit.statusCode).toBe(200);
    const titles = (hit.json().results as Array<{ title: string }>).map((r) => r.title);
    expect(titles).toContain("Alpha");
    expect(titles).not.toContain("Beta runbook");

    const byTitle = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=runbook`, cookies: s.adminCookie });
    expect((byTitle.json().results as Array<{ title: string }>).some((r) => r.title === "Beta runbook")).toBe(true);

    const miss = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=nonexistentword`, cookies: s.adminCookie });
    expect(miss.json().results).toHaveLength(0);
  });

  it("finds stop words like \"this\" (substring match, not full-text)", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "stop", "Stop", "This is the deployment plan");
    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=this`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const hit = (res.json().results as Array<{ title: string; snippet: string | null }>).find((r) => r.title === "Stop");
    expect(hit).toBeTruthy();
    expect(hit!.snippet).toContain(HL_START); // the match is highlighted
  });

  it("matches partial words and is case-insensitive", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "part", "Part", "the new Laptop is on the desk");
    // substring inside "Laptop"
    const partial = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=apto`, cookies: s.adminCookie });
    expect((partial.json().results as Array<{ title: string }>).some((r) => r.title === "Part")).toBe(true);
    // different case
    const cased = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=LAPTOP`, cookies: s.adminCookie });
    const hit = (cased.json().results as Array<{ title: string; snippet: string | null }>).find((r) => r.title === "Part");
    expect(hit).toBeTruthy();
    expect(hit!.snippet).toContain(HL_START + "Laptop" + HL_STOP); // original casing preserved in the snippet
  });

  it("keeps one- and two-character queries title-only to avoid body scans", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "title-ai", "AI handbook", "nothing relevant in body");
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "body-ai", "Body only", "AI appears only in this document body");

    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=AI`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const hits = res.json().results as Array<{ title: string; snippet: string | null }>;
    expect(hits.map((r) => r.title)).toContain("AI handbook");
    expect(hits.map((r) => r.title)).not.toContain("Body only");
    expect(hits.find((r) => r.title === "AI handbook")!.snippet).toBeNull();
  });

  it("excludes documents the user cannot read", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "secret", "Secret", "classified zorptastic material");
    const u = await createUser("nomatch@t.co");
    await addMember(s.ws.id, u.id, "member"); // member, no grant on the folder
    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: sessionFor(u.id) });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(0);
    // grant viewer → now visible
    await grant(s.ws.id, "user", u.id, "folder", s.folderId, "viewer");
    const after = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: sessionFor(u.id) });
    expect((after.json().results as unknown[]).length).toBeGreaterThan(0);
  });

  it("requires workspaceId; empty query returns no results", async () => {
    const s = await baseScenario();
    expect((await req({ method: "GET", url: "/api/search?q=x", cookies: s.adminCookie })).statusCode).toBe(400);
    expect((await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=`, cookies: s.adminCookie })).json().results).toHaveLength(0);
  });

  it("returns readable docs even when many unreadable docs rank above them (no cutoff false-negative)", async () => {
    const s = await baseScenario();
    // A second folder the member CAN read.
    const readable = await prisma.folder.create({
      data: { workspaceId: s.ws.id, name: "Readable", slug: "readable", path: "readable", createdById: s.admin.id, updatedById: s.admin.id },
    });
    const u = await createUser("paged@t.co");
    await addMember(s.ws.id, u.id, "member");
    await grant(s.ws.id, "user", u.id, "folder", readable.id, "viewer");

    // 80 high-ranking matches in the admin-only folder (term repeated → ranks above the readable one).
    const heavy = "zorptastic ".repeat(8).trim();
    await prisma.document.createMany({
      data: Array.from({ length: 80 }, (_, i) => ({
        workspaceId: s.ws.id, folderId: s.folderId, title: `Heavy ${i}`, slug: `heavy-${i}`, path: `heavy-${i}`,
        searchText: heavy, createdById: s.admin.id, updatedById: s.admin.id,
      })),
    });
    // One low-ranking readable match (single occurrence), in the readable folder.
    await prisma.document.create({
      data: { workspaceId: s.ws.id, folderId: readable.id, title: "Needle", slug: "needle", path: "readable/needle",
        searchText: "a single zorptastic mention", createdById: s.admin.id, updatedById: s.admin.id },
    });

    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: sessionFor(u.id) });
    expect(res.statusCode).toBe(200);
    const titles = (res.json().results as Array<{ title: string }>).map((r) => r.title);
    expect(titles).toEqual(["Needle"]); // the only readable match, found past the first ranked page
  });

  it("treats special characters in the query as inert (no 500)", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "punct", "Punct", "alpha & beta | gamma <tag> zorptastic");
    for (const q of ["a & b", "<script>", "foo|bar", "'; DROP TABLE", ":*", "!!!"]) {
      const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=${encodeURIComponent(q)}`, cookies: s.adminCookie });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().results)).toBe(true);
    }
  });

  it("a soft-deleted document drops out of search", async () => {
    const s = await baseScenario();
    const id = await createDoc(s.ws.id, s.folderId, s.adminCookie, "gone", "Gone", "transient zorptastic note");
    expect((await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: s.adminCookie })).json().results.length).toBeGreaterThan(0);
    await req({ method: "DELETE", url: `/api/documents/${id}`, cookies: s.adminCookie });
    expect((await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: s.adminCookie })).json().results).toHaveLength(0);
  });
});


describe("search snippets + reindex", () => {
  it("returns a highlighted body snippet when the match is in the content", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "deploy", "Deploy guide",
      "Run the migration then restart the zorptastic worker pool before traffic returns.");

    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const hit = (res.json().results as Array<{ title: string; snippet: string | null }>).find((r) => r.title === "Deploy guide");
    expect(hit).toBeTruthy();
    expect(hit!.snippet).toContain(HL_START + "zorptastic" + HL_STOP);
  });

  it("snippet is null when only the title matches", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "onlytitle", "Quarterly zorptastic review", "nothing relevant in the body");
    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: s.adminCookie });
    const hit = (res.json().results as Array<{ title: string; snippet: string | null }>).find((r) => r.title === "Quarterly zorptastic review");
    expect(hit).toBeTruthy();
    expect(hit!.snippet).toBeNull();
  });

  it("does not let document HTML leak into the snippet as markup (markers are non-HTML)", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "xss", "XSS doc", "before <script>alert(1)</script> zorptastic after");
    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: s.adminCookie });
    const hit = (res.json().results as Array<{ snippet: string | null }>).find((r) => r.snippet);
    expect(hit!.snippet).not.toContain("<b>");
    expect(hit!.snippet).toContain(HL_START); // highlight uses the private-use markers
  });

  it("reindex repopulates legacy searchText so body terms become findable", async () => {
    const s = await baseScenario();
    const id = await createDoc(s.ws.id, s.folderId, s.adminCookie, "legacy", "Legacy", "an obscure quetzalcrumb appears here");
    // Simulate a legacy/imported doc whose searchText was never populated.
    await prisma.document.update({ where: { id }, data: { searchText: null } });
    expect((await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=quetzalcrumb`, cookies: s.adminCookie })).json().results).toHaveLength(0);

    const reidx = await req({ method: "POST", url: "/api/search/reindex", cookies: s.adminCookie, payload: { workspaceId: s.ws.id } });
    expect(reidx.statusCode).toBe(200);
    expect(reidx.json().reindexed).toBeGreaterThan(0);

    const after = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=quetzalcrumb`, cookies: s.adminCookie });
    expect((after.json().results as unknown[]).length).toBeGreaterThan(0);
  });

  it("strips literal highlight markers from content so they cannot fake a highlight", async () => {
    const s = await baseScenario();
    await createDoc(s.ws.id, s.folderId, s.adminCookie, "marker", "Marker doc", `pre ${HL_START}evil${HL_STOP} zorptastic post`);
    const res = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=zorptastic`, cookies: s.adminCookie });
    const hit = (res.json().results as Array<{ snippet: string | null }>).find((r) => r.snippet);
    expect(hit!.snippet).toContain(HL_START + "zorptastic" + HL_STOP); // only the real match is wrapped
    expect(hit!.snippet).not.toContain(HL_START + "evil"); // injected markers were stripped
  });

  it("reindex only touches unindexed (searchText IS NULL) docs — never clobbers an indexed one", async () => {
    const s = await baseScenario();
    const indexed = await createDoc(s.ws.id, s.folderId, s.adminCookie, "indexed", "Indexed", "current body content");
    await prisma.document.update({ where: { id: indexed }, data: { searchText: "SENTINEL_KEEP_ME" } });
    const legacy = await createDoc(s.ws.id, s.folderId, s.adminCookie, "legacy2", "Legacy2", "the rare wibblethorpe term");
    await prisma.document.update({ where: { id: legacy }, data: { searchText: null } });

    const res = await req({ method: "POST", url: "/api/search/reindex", cookies: s.adminCookie, payload: { workspaceId: s.ws.id } });
    expect(res.statusCode).toBe(200);

    const indexedAfter = await prisma.document.findUniqueOrThrow({ where: { id: indexed }, select: { searchText: true } });
    expect(indexedAfter.searchText).toBe("SENTINEL_KEEP_ME"); // untouched
    const legacyAfter = await prisma.document.findUniqueOrThrow({ where: { id: legacy }, select: { searchText: true } });
    expect(legacyAfter.searchText).toContain("wibblethorpe"); // repopulated from storage
  });

  it("reindex is workspace-admin only (non-admin member gets 404)", async () => {
    const s = await baseScenario();
    const u = await createUser("plainmember@t.co");
    await addMember(s.ws.id, u.id, "member");
    const res = await req({ method: "POST", url: "/api/search/reindex", cookies: sessionFor(u.id), payload: { workspaceId: s.ws.id } });
    expect(res.statusCode).toBe(404);
    expect((await req({ method: "POST", url: "/api/search/reindex", cookies: s.adminCookie, payload: {} })).statusCode).toBe(400);
  });
});
