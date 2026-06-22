import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeApp, getApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";
import { registerServerAnalyticsListener, type ServerEventPayload } from "../../src/lib/analytics-bus.js";

let events: Array<{ event: string; payload: ServerEventPayload }> = [];

beforeAll(async () => {
  await getApp();
});
afterAll(async () => {
  await closeApp();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  events = [];
  registerServerAnalyticsListener({
    track(event, payload) {
      events.push({ event, payload });
    },
  });
});
afterEach(() => {
  registerServerAnalyticsListener(null);
});

const names = () => events.map((e) => e.event);

describe("server-side core-action capture (blocker-resilient)", () => {
  it("human browser open emits document_read; token read does not; repeat read is deduped", async () => {
    const s = await baseScenario();
    events = [];

    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(read.statusCode).toBe(200);
    const ev = events.find((e) => e.event === "document_read");
    expect(ev).toBeTruthy();
    expect(ev!.payload.workspaceId).toBe(s.ws.id);
    expect(ev!.payload.actor).toEqual({ userId: s.admin.id, tokenId: null });
    expect(ev!.payload.properties).toMatchObject({ doc_id: s.docId, change_source: "web_app" });

    // Repeat read by the same user within the dedupe window: no second event.
    events = [];
    await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(names()).not.toContain("document_read");

    // Token (agent/API) read does NOT emit the human core event.
    const tok = await req({ method: "POST", url: "/api/tokens", cookies: s.adminCookie, payload: { name: "T" } });
    const raw = tok.json().token as string;
    events = [];
    await req({ method: "GET", url: `/api/documents/${s.docId}`, headers: bearer(raw) });
    expect(names()).not.toContain("document_read");
  });

  it("human create emits document_created; save emits document_saved; no-op save does not", async () => {
    const s = await baseScenario();
    events = [];

    const created = await req({
      method: "POST",
      url: "/api/documents",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "Notes", slug: "notes", content: "# Notes\n" },
    });
    expect(created.statusCode).toBe(201);
    const createdEv = events.find((e) => e.event === "document_created");
    expect(createdEv).toBeTruthy();
    expect(createdEv!.payload.properties).toMatchObject({ doc_id: created.json().id, change_source: "web_app" });

    // Real edit -> document_saved.
    events = [];
    const save = await req({
      method: "PUT",
      url: `/api/documents/${created.json().id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: created.json().version, content: "# Notes\n\nmore\n" },
    });
    expect(save.statusCode).toBe(200);
    expect(names()).toContain("document_saved");

    // No-op save (identical content) -> no document_saved.
    events = [];
    await req({
      method: "PUT",
      url: `/api/documents/${created.json().id}`,
      cookies: s.adminCookie,
      payload: { baseVersion: save.json().version, content: "# Notes\n\nmore\n" },
    });
    expect(names()).not.toContain("document_saved");
  });

  it("human search emits search_performed with length only (never the query text)", async () => {
    const s = await baseScenario();
    events = [];
    const res = await req({
      method: "GET",
      url: `/api/search?workspaceId=${s.ws.id}&q=runbook`,
      cookies: s.adminCookie,
    });
    expect(res.statusCode).toBe(200);
    const ev = events.find((e) => e.event === "search_performed");
    expect(ev).toBeTruthy();
    expect(ev!.payload.properties).toMatchObject({ length: 7 });
    expect(JSON.stringify(ev!.payload.properties)).not.toContain("runbook");
  });
});
