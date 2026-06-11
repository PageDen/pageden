import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, sessionFor, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, grant, createWorkspace } from "../fixtures/seed.js";
import { createRawToken, hashToken } from "../../src/tokens.js";
import { env } from "../../src/env.js";
import { MAX_ATTACHMENT_BYTES } from "../../src/attachments/routes.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452deadbeef", "hex");

async function upload(docId: string, auth: Record<string, string>, name: string, body: Buffer, contentType = "application/octet-stream") {
  const isBearer = "authorization" in auth;
  return req({
    method: "POST",
    url: `/api/documents/${docId}/attachments?filename=${encodeURIComponent(name)}`,
    headers: { "content-type": contentType, ...(isBearer ? { authorization: auth.authorization } : {}) },
    cookies: isBearer ? undefined : auth,
    payload: body,
  });
}

describe("attachments", () => {
  it("uploads, lists, and downloads bytes (manager)", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "diagram.png", PNG, "image/png");
    expect(up.statusCode).toBe(201);
    const meta = up.json();
    expect(meta.filename).toBe("diagram.png");
    expect(meta.contentType).toBe("image/png");
    expect(meta.size).toBe(PNG.length);
    expect(typeof meta.sha256).toBe("string");

    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie });
    expect(list.statusCode).toBe(200);
    expect((list.json().attachments as Array<{ id: string }>).map((a) => a.id)).toContain(meta.id);

    const dl = await req({ method: "GET", url: `/api/attachments/${meta.id}`, cookies: s.adminCookie });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("image/png");
    expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
  });

  it("dedupes identical bytes to one storage object", async () => {
    const s = await baseScenario();
    const a = await upload(s.docId, s.adminCookie, "a.bin", PNG);
    const b = await upload(s.docId, s.adminCookie, "b.bin", PNG);
    const [ra, rb] = await Promise.all([
      prisma.attachment.findUniqueOrThrow({ where: { id: a.json().id }, select: { storageKey: true } }),
      prisma.attachment.findUniqueOrThrow({ where: { id: b.json().id }, select: { storageKey: true } }),
    ]);
    expect(ra.storageKey).toBe(rb.storageKey); // content-addressed
    expect(a.json().id).not.toBe(b.json().id); // but distinct rows/filenames
  });

  it("rejects empty body and missing filename", async () => {
    const s = await baseScenario();
    const empty = await req({ method: "POST", url: `/api/documents/${s.docId}/attachments?filename=x.bin`, headers: { "content-type": "application/octet-stream" }, cookies: s.adminCookie, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
    const noName = await req({ method: "POST", url: `/api/documents/${s.docId}/attachments`, headers: { "content-type": "application/octet-stream" }, cookies: s.adminCookie, payload: PNG });
    expect(noName.statusCode).toBe(400);
  });

  it("enforces permissions: viewer cannot upload/delete; non-member cannot read; editor can", async () => {
    const s = await baseScenario();
    // viewer
    const viewer = await createUser("viewer@t.co");
    await addMember(s.ws.id, viewer.id, "member");
    await grant(s.ws.id, "user", viewer.id, "folder", s.folderId, "viewer");
    const vUp = await upload(s.docId, sessionFor(viewer.id), "v.bin", PNG);
    expect(vUp.statusCode).toBe(403);

    // editor can upload
    const editor = await createUser("editor@t.co");
    await addMember(s.ws.id, editor.id, "member");
    await grant(s.ws.id, "user", editor.id, "folder", s.folderId, "editor");
    const eUp = await upload(s.docId, sessionFor(editor.id), "e.bin", PNG);
    expect(eUp.statusCode).toBe(201);
    const attId = eUp.json().id;

    // viewer can download (read) but not delete
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: sessionFor(viewer.id) })).statusCode).toBe(200);
    expect((await req({ method: "DELETE", url: `/api/attachments/${attId}`, cookies: sessionFor(viewer.id) })).statusCode).toBe(403);

    // non-member (no grant) gets 404 on document-scoped + attachment-scoped routes (existence hidden)
    const outsider = await createUser("outsider@t.co");
    await addMember(s.ws.id, outsider.id, "member");
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: sessionFor(outsider.id) })).statusCode).toBe(404);
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: sessionFor(outsider.id) })).statusCode).toBe(404);
    expect((await req({ method: "POST", url: `/api/documents/${s.docId}/attachments?filename=o.bin`, headers: { "content-type": "application/octet-stream" }, cookies: sessionFor(outsider.id), payload: PNG })).statusCode).toBe(404);
  });

  it("soft-delete removes it from list and download", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "gone.bin", PNG);
    const attId = up.json().id;
    expect((await req({ method: "DELETE", url: `/api/attachments/${attId}`, cookies: s.adminCookie })).statusCode).toBe(200);
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: s.adminCookie })).statusCode).toBe(404);
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie })).json().attachments).toHaveLength(0);
  });

  it("supports bearer-token (plugin) upload + download", async () => {
    const s = await baseScenario();
    const raw = createRawToken();
    await prisma.apiToken.create({ data: { userId: s.admin.id, name: "plugin", tokenHash: hashToken(raw, env.tokenHashSecret) } });
    const up = await upload(s.docId, bearer(raw), "plugin.bin", PNG);
    expect(up.statusCode).toBe(201);
    const dl = await req({ method: "GET", url: `/api/attachments/${up.json().id}`, headers: bearer(raw) });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
  });

  it("download sets X-Content-Type-Options: nosniff", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "x.bin", PNG);
    const dl = await req({ method: "GET", url: `/api/attachments/${up.json().id}`, cookies: s.adminCookie });
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects an oversized upload with 413", async () => {
    const s = await baseScenario();
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1);
    const res = await req({ method: "POST", url: `/api/documents/${s.docId}/attachments?filename=big.bin`, headers: { "content-type": "application/octet-stream" }, cookies: s.adminCookie, payload: big });
    expect(res.statusCode).toBe(413);
  });

  it("the raw-body parser is scoped: a JSON route does not accept octet-stream", async () => {
    const s = await baseScenario();
    // POST /api/documents expects JSON; an octet-stream body has no parser outside the attachment
    // plugin scope, so Fastify rejects it as unsupported media type rather than buffering it.
    const res = await req({ method: "POST", url: "/api/documents", headers: { "content-type": "application/octet-stream" }, cookies: s.adminCookie, payload: Buffer.from("not json") });
    expect(res.statusCode).toBe(415);
  });

  it("attachments of a soft-deleted document become 404", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "doomed.bin", PNG);
    const attId = up.json().id;
    expect((await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: s.adminCookie })).statusCode).toBe(200);
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: s.adminCookie })).statusCode).toBe(404);
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie })).statusCode).toBe(404);
  });

  it("cross-workspace: an outsider cannot read another workspace's attachment id (404)", async () => {
    const s = await baseScenario();
    // A second, independent workspace with its own admin, folder, document, and attachment.
    const ws2 = await createWorkspace("WS2", "ws2");
    const admin2 = await createUser("admin2@t.co", "Admin2");
    await addMember(ws2.id, admin2.id, "admin");
    const c2 = sessionFor(admin2.id);
    const folder2 = await req({ method: "POST", url: "/api/folders", cookies: c2, payload: { workspaceId: ws2.id, name: "F2", slug: "f2" } });
    const doc2 = await req({ method: "POST", url: "/api/documents", cookies: c2, payload: { workspaceId: ws2.id, folderId: folder2.json().id, title: "D2", slug: "d2", content: "x" } });
    const up2 = await upload(doc2.json().id, c2, "secret2.bin", PNG);
    expect(up2.statusCode).toBe(201);
    // s.admin is not a member of ws2 → 404, not 403.
    expect((await req({ method: "GET", url: `/api/attachments/${up2.json().id}`, cookies: s.adminCookie })).statusCode).toBe(404);
    expect((await req({ method: "DELETE", url: `/api/attachments/${up2.json().id}`, cookies: s.adminCookie })).statusCode).toBe(404);
  });
});
