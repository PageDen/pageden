import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";
import { canonicalize } from "../../src/checksum.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(canonicalize(content), "utf8").digest("hex")}`;
}

describe("headless Obsidian plugin ↔ server full loop", () => {
  it("downloads, pushes, searches, and syncs an attachment through bearer-token endpoints", async () => {
    const s = await baseScenario();
    const token = await req({ method: "POST", url: "/api/tokens", cookies: s.adminCookie, payload: { name: "Plugin E2E" } });
    expect(token.statusCode).toBe(201);
    const auth = bearer(token.json().token);

    const tree = await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, headers: auth });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().documents.some((d: { id: string }) => d.id === s.docId)).toBe(true);

    const downloaded = await req({ method: "GET", url: `/api/documents/${s.docId}`, headers: auth });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.json().content).toBe("# Runbook\n");

    const content = "# Runbook\n\nEdited from headless plugin automation.\n";
    const pushed = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/push`,
      headers: auth,
      payload: { baseVersion: downloaded.json().version, checksum: sha256(content), content },
    });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().checksum).toBe(sha256(content));

    const search = await req({ method: "GET", url: `/api/search?workspaceId=${s.ws.id}&q=headless%20plugin`, headers: auth });
    expect(search.statusCode).toBe(200);
    expect(search.json().results.some((d: { id: string }) => d.id === s.docId)).toBe(true);

    const upload = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/attachments?filename=diagram.png`,
      headers: { ...auth, "content-type": "image/png" },
      payload: Buffer.from([137, 80, 78, 71]),
    });
    expect(upload.statusCode).toBe(201);

    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().attachments).toEqual([expect.objectContaining({ id: upload.json().id, filename: "diagram.png" })]);

    const download = await req({ method: "GET", url: `/api/attachments/${upload.json().id}`, headers: auth });
    expect(download.statusCode).toBe(200);
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.rawPayload).toEqual(Buffer.from([137, 80, 78, 71]));
  });
});
