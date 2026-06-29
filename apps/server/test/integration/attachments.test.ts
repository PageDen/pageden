import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, sessionFor, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, grant, createWorkspace } from "../fixtures/seed.js";
import { createRawToken, hashToken } from "../../src/tokens.js";
import { env } from "../../src/env.js";
import { MAX_ATTACHMENT_BYTES } from "../../src/attachments/routes.js";
import { drainScanWorker, setScanner } from "../../src/attachments/scanner.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setScanner(undefined); });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452deadbeef", "hex");
// Standard EICAR test string — any real ClamAV detects this as Eicar-Signature.
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

async function upload(docId: string, auth: Record<string, string>, name: string, body: Buffer, contentType = "image/png") {
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
    expect(up.statusCode).toBe(202);
    const meta = up.json();
    expect(meta.filename).toBe("diagram.png");
    expect(meta.contentType).toBe("image/png");
    expect(meta.size).toBe(PNG.length);
    expect(typeof meta.sha256).toBe("string");
    expect(meta.status).toBe("scanning"); // scan is async; drain before downloading

    await drainScanWorker();

    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie });
    expect(list.statusCode).toBe(200);
    expect((list.json().attachments as Array<{ id: string }>).map((a) => a.id)).toContain(meta.id);

    const dl = await req({ method: "GET", url: `/api/attachments/${meta.id}`, cookies: s.adminCookie });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("image/png");
    expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
  });

  it("upload response includes status field (scanning on create)", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "test.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    expect(up.json().status).toBe("scanning");
  });

  it("meta polling endpoint returns attachment metadata with status", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "poll.png", PNG, "image/png");
    const id = up.json().id;

    await drainScanWorker(); // wait for scan to promote to ready

    const meta = await req({ method: "GET", url: `/api/attachments/${id}/meta`, cookies: s.adminCookie });
    expect(meta.statusCode).toBe(200);
    const body = meta.json();
    expect(body.id).toBe(id);
    expect(body.status).toBe("ready");
    expect(body.filename).toBe("poll.png");
  });

  it("meta polling endpoint is permission-gated (non-member gets 404)", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "secret.png", PNG, "image/png");
    const id = up.json().id;
    const outsider = await createUser("out@t.co");
    await addMember(s.ws.id, outsider.id, "member");
    const res = await req({ method: "GET", url: `/api/attachments/${id}/meta`, cookies: sessionFor(outsider.id) });
    expect(res.statusCode).toBe(404);
  });

  it("SCANNING attachment is not downloadable — 503 with retry-after until scan completes", async () => {
    const s = await baseScenario();

    // Block the scanner so the attachment stays SCANNING while we attempt the download.
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    setScanner(async () => { await blocked; return "clean"; });

    const up = await upload(s.docId, s.adminCookie, "pending.png", PNG, "image/png");
    const id = up.json().id;

    const dl = await req({ method: "GET", url: `/api/attachments/${id}`, cookies: s.adminCookie });
    expect(dl.statusCode).toBe(503);
    expect(dl.headers["retry-after"]).toBe("5");

    // Release the scanner and confirm it becomes downloadable.
    unblock();
    await drainScanWorker();
    const dl2 = await req({ method: "GET", url: `/api/attachments/${id}`, cookies: s.adminCookie });
    expect(dl2.statusCode).toBe(200);
  });

  it("infected file is quarantined — meta shows quarantined, download blocked (403)", async () => {
    const s = await baseScenario();
    setScanner(async (data) => Buffer.compare(data, EICAR) === 0 ? "infected" : "clean");

    const up = await upload(s.docId, s.adminCookie, "virus.png", EICAR, "image/png");
    expect(up.statusCode).toBe(202);
    const id = up.json().id;

    await drainScanWorker();

    const meta = await req({ method: "GET", url: `/api/attachments/${id}/meta`, cookies: s.adminCookie });
    expect(meta.json().status).toBe("quarantined");

    const dl = await req({ method: "GET", url: `/api/attachments/${id}`, cookies: s.adminCookie });
    expect(dl.statusCode).toBe(403);
  });

  it("scanner runtime failures become scan_failed and block download with 503", async () => {
    const s = await baseScenario();
    setScanner(async () => {
      throw new Error("scanner offline");
    });

    const up = await upload(s.docId, s.adminCookie, "scan-fail.png", PNG, "image/png");
    expect(up.statusCode).toBe(202);
    const id = up.json().id;

    await drainScanWorker();

    const meta = await req({ method: "GET", url: `/api/attachments/${id}/meta`, cookies: s.adminCookie });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().status).toBe("scan_failed");

    const dl = await req({ method: "GET", url: `/api/attachments/${id}`, cookies: s.adminCookie });
    expect(dl.statusCode).toBe(503);
    expect(dl.json().error).toBe("scan_failed");
  });

  it("rejects disallowed MIME type with 415", async () => {
    const s = await baseScenario();
    const res = await upload(s.docId, s.adminCookie, "bad.bin", PNG, "application/octet-stream");
    expect(res.statusCode).toBe(415);
  });

  it("accepts all allowed MIME types", async () => {
    const s = await baseScenario();
    const allowed = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "video/mp4",
      "video/webm",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
    ];
    for (const mime of allowed) {
      const res = await upload(s.docId, s.adminCookie, `file.bin`, PNG, mime);
      expect(res.statusCode, `expected 202 for MIME ${mime}`).toBe(202);
    }
  });

  it("dedupes identical bytes to one storage object", async () => {
    const s = await baseScenario();
    const a = await upload(s.docId, s.adminCookie, "a.png", PNG);
    const b = await upload(s.docId, s.adminCookie, "b.png", PNG);
    const [ra, rb] = await Promise.all([
      prisma.attachment.findUniqueOrThrow({ where: { id: a.json().id }, select: { storageKey: true } }),
      prisma.attachment.findUniqueOrThrow({ where: { id: b.json().id }, select: { storageKey: true } }),
    ]);
    expect(ra.storageKey).toBe(rb.storageKey); // content-addressed
    expect(a.json().id).not.toBe(b.json().id); // but distinct rows/filenames
  });

  it("rejects empty body and missing filename", async () => {
    const s = await baseScenario();
    const empty = await req({ method: "POST", url: `/api/documents/${s.docId}/attachments?filename=x.png`, headers: { "content-type": "image/png" }, cookies: s.adminCookie, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
    const noName = await req({ method: "POST", url: `/api/documents/${s.docId}/attachments`, headers: { "content-type": "image/png" }, cookies: s.adminCookie, payload: PNG });
    expect(noName.statusCode).toBe(400);
  });

  it("enforces permissions: viewer cannot upload/delete; non-member cannot read; editor can", async () => {
    const s = await baseScenario();
    // viewer
    const viewer = await createUser("viewer@t.co");
    await addMember(s.ws.id, viewer.id, "member");
    await grant(s.ws.id, "user", viewer.id, "folder", s.folderId, "viewer");
    const vUp = await upload(s.docId, sessionFor(viewer.id), "v.png", PNG);
    expect(vUp.statusCode).toBe(403);

    // editor can upload
    const editor = await createUser("editor@t.co");
    await addMember(s.ws.id, editor.id, "member");
    await grant(s.ws.id, "user", editor.id, "folder", s.folderId, "editor");
    const eUp = await upload(s.docId, sessionFor(editor.id), "e.png", PNG);
    expect(eUp.statusCode).toBe(202);
    const attId = eUp.json().id;

    await drainScanWorker();

    // viewer can download (read) but not delete
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: sessionFor(viewer.id) })).statusCode).toBe(200);
    expect((await req({ method: "DELETE", url: `/api/attachments/${attId}`, cookies: sessionFor(viewer.id) })).statusCode).toBe(403);

    // non-member (no grant) gets 404 on document-scoped + attachment-scoped routes (existence hidden)
    const outsider = await createUser("outsider@t.co");
    await addMember(s.ws.id, outsider.id, "member");
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: sessionFor(outsider.id) })).statusCode).toBe(404);
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: sessionFor(outsider.id) })).statusCode).toBe(404);
    expect((await req({ method: "POST", url: `/api/documents/${s.docId}/attachments?filename=o.png`, headers: { "content-type": "image/png" }, cookies: sessionFor(outsider.id), payload: PNG })).statusCode).toBe(404);
  });

  it("soft-delete removes it from list and download", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "gone.png", PNG);
    const attId = up.json().id;
    expect((await req({ method: "DELETE", url: `/api/attachments/${attId}`, cookies: s.adminCookie })).statusCode).toBe(200);
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: s.adminCookie })).statusCode).toBe(404);
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie })).json().attachments).toHaveLength(0);
  });

  it("refuses to delete an attachment still linked in the current document body", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "linked.png", PNG);
    const attId = up.json().id as string;
    await drainScanWorker();

    const save = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      cookies: s.adminCookie,
      payload: { baseVersion: s.version, content: `# Linked\n\n![linked](/api/attachments/${attId})\n` },
    });
    expect(save.statusCode).toBe(200);

    const del = await req({ method: "DELETE", url: `/api/attachments/${attId}`, cookies: s.adminCookie });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe("attachment_linked");
  });

  it("supports bearer-token (plugin) upload + download", async () => {
    const s = await baseScenario();
    const raw = createRawToken();
    await prisma.apiToken.create({ data: { userId: s.admin.id, name: "plugin", tokenHash: hashToken(raw, env.tokenHashSecret) } });
    const up = await upload(s.docId, bearer(raw), "plugin.png", PNG);
    expect(up.statusCode).toBe(202);

    await drainScanWorker();

    const dl = await req({ method: "GET", url: `/api/attachments/${up.json().id}`, headers: bearer(raw) });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
  });

  it("download sets X-Content-Type-Options: nosniff", async () => {
    const s = await baseScenario();
    const up = await upload(s.docId, s.adminCookie, "x.png", PNG);
    await drainScanWorker();
    const dl = await req({ method: "GET", url: `/api/attachments/${up.json().id}`, cookies: s.adminCookie });
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects an oversized upload with 413", async () => {
    const s = await baseScenario();
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1);
    const res = await req({ method: "POST", url: `/api/documents/${s.docId}/attachments?filename=big.png`, headers: { "content-type": "image/png" }, cookies: s.adminCookie, payload: big });
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
    const up = await upload(s.docId, s.adminCookie, "doomed.png", PNG);
    const attId = up.json().id;
    expect((await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: s.adminCookie })).statusCode).toBe(200);
    expect((await req({ method: "GET", url: `/api/attachments/${attId}`, cookies: s.adminCookie })).statusCode).toBe(404);
    expect((await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie })).statusCode).toBe(404);
  });

  it("admin: list quarantined returns the quarantined row; non-admin gets 403", async () => {
    const s = await baseScenario();
    setScanner(async () => "infected");
    const up = await upload(s.docId, s.adminCookie, "virus.png", EICAR, "image/png");
    await drainScanWorker();

    const list = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/attachments/quarantined`, cookies: s.adminCookie });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { attachments: Array<{ id: string }>; next: string | null };
    expect(body.attachments.map((a) => a.id)).toContain(up.json().id);
    expect(body.next).toBeNull();

    const member = await createUser("member@t.co");
    await addMember(s.ws.id, member.id, "member");
    const denied = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/attachments/quarantined`, cookies: sessionFor(member.id) });
    expect(denied.statusCode).toBe(403);
  });

  it("admin: unquarantine re-queues for scan and resolves to ready when scanner is clean", async () => {
    const s = await baseScenario();
    setScanner(async () => "infected");
    const up = await upload(s.docId, s.adminCookie, "virus.png", EICAR, "image/png");
    await drainScanWorker();
    const id = up.json().id;

    setScanner(async () => "clean");
    const unq = await req({ method: "POST", url: `/api/attachments/${id}/unquarantine`, cookies: s.adminCookie });
    expect(unq.statusCode).toBe(200);
    expect(unq.json().ok).toBe(true);

    await drainScanWorker();
    const after = await req({ method: "GET", url: `/api/attachments/${id}/meta`, cookies: s.adminCookie });
    expect(after.json().status).toBe("ready");
  });

  it("unquarantine: 404 for non-existent or non-quarantined attachment", async () => {
    const s = await baseScenario();
    const notFound = await req({ method: "POST", url: "/api/attachments/no-such-id/unquarantine", cookies: s.adminCookie });
    expect(notFound.statusCode).toBe(404);
  });

  it("unquarantine: non-admin gets 403", async () => {
    const s = await baseScenario();
    setScanner(async () => "infected");
    const up = await upload(s.docId, s.adminCookie, "v2.png", EICAR, "image/png");
    await drainScanWorker();

    const member = await createUser("member2@t.co");
    await addMember(s.ws.id, member.id, "member");
    const denied = await req({ method: "POST", url: `/api/attachments/${up.json().id}/unquarantine`, cookies: sessionFor(member.id) });
    expect(denied.statusCode).toBe(403);
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
    const up2 = await upload(doc2.json().id, c2, "secret2.png", PNG);
    expect(up2.statusCode).toBe(202);
    // s.admin is not a member of ws2 → 404, not 403.
    expect((await req({ method: "GET", url: `/api/attachments/${up2.json().id}`, cookies: s.adminCookie })).statusCode).toBe(404);
    expect((await req({ method: "DELETE", url: `/api/attachments/${up2.json().id}`, cookies: s.adminCookie })).statusCode).toBe(404);
  });
});
