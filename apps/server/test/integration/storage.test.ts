import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { utimes } from "node:fs/promises";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";
import { canonicalize } from "../../src/checksum.js";
import { sweepOrphanObjects, storageKeyForHex, writeBlob, writeContent } from "../../src/storage.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

function objectPath(content: string, workspaceId: string): string {
  const hex = createHash("sha256").update(canonicalize(content), "utf8").digest("hex");
  return join(process.env.STORAGE_ROOT!, storageKeyForHex(hex, workspaceId));
}

describe("storage atomicity + orphan sweep", () => {
  it("sweep removes unreferenced objects (crash/rollback residue) and keeps referenced ones", async () => {
    const s = await baseScenario();
    const referenced = objectPath("# Runbook\n", s.ws.id);
    expect(existsSync(referenced)).toBe(true); // the document's committed object

    // Simulate an object left behind by a crashed/rolled-back write: written, never referenced.
    const orphanContent = `orphan-${Date.now()}\n`;
    await writeContent(orphanContent, s.ws.id);
    const orphan = objectPath(orphanContent, s.ws.id);
    expect(existsSync(orphan)).toBe(true);

    const swept = await sweepOrphanObjects(prisma, 0);
    expect(swept.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(orphan)).toBe(false); // orphan removed
    expect(existsSync(referenced)).toBe(true); // referenced object kept

    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toBe("# Runbook\n");
  });

  it("a stale write is atomic: no revision row, and the preflight writes no object", async () => {
    const s = await baseScenario();
    const before = await prisma.documentRevision.count({ where: { documentId: s.docId } });

    const staleContent = `stale-${Date.now()}\n`;
    const res = await req({
      method: "POST",
      url: `/api/documents/${s.docId}/push`,
      cookies: s.adminCookie,
      payload: { baseVersion: "rev_stale", content: staleContent },
    });
    expect(res.statusCode).toBe(409);
    // No dangling revision: the rejected write created no revision row.
    expect(await prisma.documentRevision.count({ where: { documentId: s.docId } })).toBe(before);
    // The cheap preflight rejects before storage work — no object is written at all.
    expect(existsSync(objectPath(staleContent, s.ws.id))).toBe(false);
  });

  it("retrying the same content is idempotent — both revisions share one object", async () => {
    const s = await baseScenario();
    const content = "# Same Content\n";
    const r1 = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, payload: { baseVersion: s.version, content } });
    expect(r1.statusCode).toBe(200);
    const r2 = await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: s.adminCookie, payload: { baseVersion: r1.json().version, content } });
    expect(r2.statusCode).toBe(200);
    const revs = await prisma.documentRevision.findMany({ where: { id: { in: [r1.json().version, r2.json().version] } }, select: { storageKey: true } });
    expect(revs).toHaveLength(2);
    expect(revs[0]!.storageKey).toBe(revs[1]!.storageKey);
    expect(existsSync(objectPath(content, s.ws.id))).toBe(true);
  });

  it("the grace period protects newly-written (possibly in-flight) objects from the sweep", async () => {
    const fresh = `fresh-${Date.now()}\n`;
    const s = await baseScenario();
    await writeContent(fresh, s.ws.id);
    const swept = await sweepOrphanObjects(prisma, 60 * 60 * 1000); // 1h grace
    expect(swept.removed).toBe(0);
    expect(existsSync(objectPath(fresh, s.ws.id))).toBe(true);
    expect(existsSync(objectPath("# Runbook\n", s.ws.id))).toBe(true);
  });

  it("a reused (deduped) object refreshes mtime so the grace period protects an in-flight commit", async () => {
    const s = await baseScenario();
    const content = `reuse-${Date.now()}\n`;
    const { storageKey } = await writeContent(content, s.ws.id);
    const abs = join(process.env.STORAGE_ROOT!, storageKey);
    // Simulate an OLD orphan of this exact content.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(abs, old, old);
    // A new write of identical content reuses the object — it must refresh mtime.
    await writeContent(content, s.ws.id);
    // With a 1h grace, the reused object is now "fresh" and must NOT be swept, even though
    // it is not yet referenced (mimicking the window before its revision commits).
    const swept = await sweepOrphanObjects(prisma, 60 * 60 * 1000);
    expect(swept.removed).toBe(0);
    expect(existsSync(abs)).toBe(true);
  });

  it("sweeps soft-deleted attachment blobs and keeps live attachment blobs", async () => {
    const s = await baseScenario();
    const liveBlob = await writeBlob(Buffer.from("live attachment"), s.ws.id);
    const deletedBlob = await writeBlob(Buffer.from("deleted attachment"), s.ws.id);
    await prisma.attachment.create({
      data: {
        workspaceId: s.ws.id,
        documentId: s.docId,
        filename: "live.bin",
        contentType: "application/octet-stream",
        size: liveBlob.size,
        sha256: liveBlob.hex,
        storageKey: liveBlob.storageKey,
        uploadedById: s.admin.id,
      },
    });
    await prisma.attachment.create({
      data: {
        workspaceId: s.ws.id,
        documentId: s.docId,
        filename: "deleted.bin",
        contentType: "application/octet-stream",
        size: deletedBlob.size,
        sha256: deletedBlob.hex,
        storageKey: deletedBlob.storageKey,
        uploadedById: s.admin.id,
        deletedAt: new Date(),
      },
    });

    const swept = await sweepOrphanObjects(prisma, 0);

    expect(swept.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(process.env.STORAGE_ROOT!, liveBlob.storageKey))).toBe(true);
    expect(existsSync(join(process.env.STORAGE_ROOT!, deletedBlob.storageKey))).toBe(false);
  });
});
