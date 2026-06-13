import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, grant, member } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

function vaultZip(extra: Record<string, Uint8Array> = {}): Buffer {
  return Buffer.from(
    zipSync({
      "vault/Welcome.md": strToU8("# Welcome\n\nSee ![[diagram.png]] for details.\n"),
      "vault/Projects/Roadmap.md": strToU8("---\ntitle: The Roadmap\n---\n\n# Roadmap\n"),
      "vault/diagram.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      "vault/.obsidian/app.json": strToU8("{}"),
      ...extra,
    }),
  );
}

async function uploadZip(cookie: Record<string, string>, workspaceId: string, zip: Buffer, query = "") {
  return req({
    method: "POST",
    url: `/api/import/vault?workspaceId=${workspaceId}&targetRootName=Imported&conflictPolicy=skip${query}`,
    cookies: cookie,
    headers: { "content-type": "application/zip" },
    payload: zip,
  });
}

async function waitForJob(cookie: Record<string, string>, jobId: string, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const res = await req({ method: "GET", url: `/api/import/jobs/${jobId}`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    const job = res.json();
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() - start > timeoutMs) throw new Error(`import job did not finish: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("server-side vault import", () => {
  it("imports a zip end to end: folders, documents, frontmatter titles, attachments, ignore rules", async () => {
    const s = await baseScenario();
    const started = await uploadZip(s.adminCookie, s.ws.id, vaultZip());
    expect(started.statusCode).toBe(202);
    const { jobId } = started.json();

    const job = await waitForJob(s.adminCookie, jobId);
    expect(job.status).toBe("done");
    expect(job.report.documentsCreated).toBe(2);
    expect(job.report.foldersCreated).toBeGreaterThanOrEqual(2); // Imported + projects
    expect(job.report.attachmentsUploaded).toBe(1);

    const welcome = await prisma.document.findFirst({ where: { workspaceId: s.ws.id, path: "imported/welcome.md" } });
    expect(welcome).not.toBeNull();
    const roadmap = await prisma.document.findFirst({ where: { workspaceId: s.ws.id, path: "imported/projects/roadmap.md" } });
    expect(roadmap?.title).toBe("The Roadmap"); // frontmatter title wins
    const attachment = await prisma.attachment.findFirst({ where: { documentId: welcome!.id } });
    expect(attachment?.filename).toBe("diagram.png");
    // .obsidian internals are never imported
    expect(await prisma.document.findFirst({ where: { workspaceId: s.ws.id, path: { contains: "obsidian" } } })).toBeNull();
  });

  it("skips existing documents on re-import (idempotent retry semantics)", async () => {
    const s = await baseScenario();
    const first = await uploadZip(s.adminCookie, s.ws.id, vaultZip());
    await waitForJob(s.adminCookie, first.json().jobId);

    const second = await uploadZip(s.adminCookie, s.ws.id, vaultZip());
    const job = await waitForJob(s.adminCookie, second.json().jobId);
    expect(job.status).toBe("done");
    expect(job.report.documentsCreated).toBe(0);
    expect(job.report.documentsSkipped).toBe(2);
  });

  it("fails closed on zip-slip paths and the job is retryable", async () => {
    const s = await baseScenario();
    const evil = vaultZip({ "../evil.md": strToU8("# Escape\n") });
    const started = await uploadZip(s.adminCookie, s.ws.id, evil);
    expect(started.statusCode).toBe(202);
    const job = await waitForJob(s.adminCookie, started.json().jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/unsafe path/i);

    const retried = await req({ method: "POST", url: `/api/import/jobs/${job.id}/retry`, cookies: s.adminCookie });
    expect(retried.statusCode).toBe(202);
    const again = await waitForJob(s.adminCookie, job.id);
    expect(again.status).toBe("failed"); // same zip, same rejection — but the endpoint works
  });

  it("enforces destination permissions and job visibility", async () => {
    const s = await baseScenario();
    const outsider = await createUser("outsider@t.co", "Outsider");
    const outsiderCookie = sessionFor(outsider.id);

    // Non-member cannot create a top-level folder in the workspace.
    const denied = await uploadZip(outsiderCookie, s.ws.id, vaultZip());
    expect(denied.statusCode).toBe(403);

    // A plain member is not a workspace admin either.
    const m = await member(s.ws.id, "member@t.co");
    const deniedMember = await uploadZip(m.cookie, s.ws.id, vaultZip());
    expect(deniedMember.statusCode).toBe(403);

    // But a member with editor rights on an existing folder can import into it.
    await addMember(s.ws.id, outsider.id, "member");
    await grant(s.ws.id, "user", outsider.id, "folder", s.folderId, "editor");
    const intoFolder = await req({
      method: "POST",
      url: `/api/import/vault?workspaceId=${s.ws.id}&targetFolderId=${s.folderId}&conflictPolicy=skip`,
      cookies: outsiderCookie,
      headers: { "content-type": "application/zip" },
      payload: vaultZip(),
    });
    expect(intoFolder.statusCode).toBe(202);
    const job = await waitForJob(outsiderCookie, intoFolder.json().jobId);
    expect(job.status).toBe("done");
    expect(job.report.documentsCreated).toBe(2);

    // Job status is existence-hidden from other non-admin users.
    const peek = await req({ method: "GET", url: `/api/import/jobs/${job.id}`, cookies: m.cookie });
    expect(peek.statusCode).toBe(404);
  });

  it("validates the upload request shape", async () => {
    const s = await baseScenario();
    const both = await req({
      method: "POST",
      url: `/api/import/vault?workspaceId=${s.ws.id}&targetFolderId=x&targetRootName=y`,
      cookies: s.adminCookie,
      headers: { "content-type": "application/zip" },
      payload: vaultZip(),
    });
    expect(both.statusCode).toBe(400);

    const neither = await req({
      method: "POST",
      url: `/api/import/vault?workspaceId=${s.ws.id}`,
      cookies: s.adminCookie,
      headers: { "content-type": "application/zip" },
      payload: vaultZip(),
    });
    expect(neither.statusCode).toBe(400);
  });
});
