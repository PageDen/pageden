import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { z } from "zod";
import {
  meResponseSchema, documentListSchema, treeSchema, documentWithContentSchema,
  documentCreateSchema, writeResultSchema, documentRenameSchema, documentMoveSchema,
  revisionsSchema, folderCreateSchema, folderRenameSchema, folderMoveSchema,
  permissionsListSchema, permissionsWriteSchema, okSchema, okDeletedSchema, tokenCreateSchema, tokenListSchema,
  workspacesSchema, currentWorkspaceSchema, usersListSchema, userCreateSchema, groupCreateSchema, groupsListSchema, auditSchema,
  validationErrorSchema, notFoundSchema, conflictSchema, forbiddenSchema, unauthorizedSchema,
  attachmentSchema, attachmentListSchema,
} from "@pageden/api-types";
import { getApp, closeApp, req, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, member, createUser, addMember, grant, PW } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

const SECRET_KEYS = ["passwordHash", "tokenHash", "storageKey"];

function check<T extends z.ZodTypeAny>(schema: T, status: number, res: { statusCode: number; json: () => unknown }) {
  expect(res.statusCode).toBe(status);
  const body = res.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error("contract violation: " + JSON.stringify(parsed.error.issues, null, 2) + "\nbody: " + JSON.stringify(body));
  }
  // Response hygiene on every checked response.
  JSON.stringify(body, (k, v) => {
    if (SECRET_KEYS.includes(k)) throw new Error(`leaked sensitive key: ${k}`);
    return v;
  });
}

describe("contract conformance — status + shape + hygiene on every response", () => {
  it("document & folder responses", async () => {
    const s = await baseScenario();
    const c = s.adminCookie;
    check(meResponseSchema, 200, await req({ method: "GET", url: "/api/me", cookies: c }));
    check(documentListSchema, 200, await req({ method: "GET", url: `/api/documents?workspaceId=${s.ws.id}`, cookies: c }));
    check(treeSchema, 200, await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, cookies: c }));
    check(documentWithContentSchema, 200, await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: c }));
    check(documentCreateSchema, 201, await req({ method: "POST", url: "/api/documents", cookies: c, payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "D2", slug: "d2", content: "x" } }));
    check(writeResultSchema, 200, await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: c, payload: { baseVersion: s.version, content: "# v2\n" } }));
    check(documentRenameSchema, 200, await req({ method: "POST", url: `/api/documents/${s.docId}/rename`, cookies: c, payload: { slug: "renamed" } }));
    const ops = await req({ method: "POST", url: "/api/folders", cookies: c, payload: { workspaceId: s.ws.id, name: "Ops", slug: "ops" } });
    check(folderCreateSchema, 201, ops);
    check(documentMoveSchema, 200, await req({ method: "POST", url: `/api/documents/${s.docId}/move`, cookies: c, payload: { folderId: ops.json().id } }));
    check(revisionsSchema, 200, await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: c }));
    const revs = (await req({ method: "GET", url: `/api/documents/${s.docId}/revisions`, cookies: c })).json() as { revisions: Array<{ id: string }> };
    check(writeResultSchema, 200, await req({ method: "POST", url: `/api/documents/${s.docId}/revisions/${revs.revisions.at(-1)!.id}/restore`, cookies: c }));
    check(folderRenameSchema, 200, await req({ method: "POST", url: `/api/folders/${s.folderId}/rename`, cookies: c, payload: { slug: "engineering-2" } }));
    check(folderMoveSchema, 200, await req({ method: "POST", url: `/api/folders/${ops.json().id}/move`, cookies: c, payload: { parentFolderId: s.folderId } }));
    check(permissionsListSchema, 200, await req({ method: "GET", url: `/api/documents/${s.docId}/permissions`, cookies: c }));
    check(permissionsWriteSchema, 200, await req({ method: "PUT", url: `/api/folders/${s.folderId}/permissions`, cookies: c, payload: { permissions: [] } }));
    const att = await req({ method: "POST", url: `/api/documents/${s.docId}/attachments?filename=c.bin`, headers: { "content-type": "application/octet-stream" }, cookies: c, payload: Buffer.from("contract-bytes") });
    check(attachmentSchema, 201, att);
    check(attachmentListSchema, 200, await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: c }));
  });

  it("admin, token, and ok responses", async () => {
    const s = await baseScenario();
    const c = s.adminCookie;
    check(workspacesSchema, 200, await req({ method: "GET", url: "/api/workspaces", cookies: c }));
    check(currentWorkspaceSchema, 200, await req({ method: "GET", url: "/api/workspaces/current", cookies: c }));
    check(usersListSchema, 200, await req({ method: "GET", url: `/api/users?workspaceId=${s.ws.id}`, cookies: c }));
    check(userCreateSchema, 201, await req({ method: "POST", url: "/api/users", cookies: c, payload: { workspaceId: s.ws.id, email: "u2@t.co", name: "U2", password: PW } }));
    check(groupCreateSchema, 201, await req({ method: "POST", url: "/api/groups", cookies: c, payload: { workspaceId: s.ws.id, name: "G", slug: "g" } }));
    check(groupsListSchema, 200, await req({ method: "GET", url: `/api/groups?workspaceId=${s.ws.id}`, cookies: c }));
    check(auditSchema, 200, await req({ method: "GET", url: `/api/audit?workspaceId=${s.ws.id}`, cookies: c }));
    const tok = await req({ method: "POST", url: "/api/tokens", cookies: c, payload: { name: "T" } });
    check(tokenCreateSchema, 201, tok);
    check(tokenListSchema, 200, await req({ method: "GET", url: "/api/tokens", cookies: c }));
    check(okSchema, 200, await req({ method: "POST", url: `/api/tokens/${tok.json().id}/revoke`, cookies: c }));
    check(okDeletedSchema, 200, await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: c }));
  });

  it("tree folder permission may be null for ancestor-only-visible folders", async () => {
    const s = await baseScenario();
    // sub-folder with a document; grant the member ONLY a document-level role (no folder role).
    const sub = await req({ method: "POST", url: "/api/folders", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, parentFolderId: s.folderId, name: "Sub", slug: "sub" } });
    const d = await req({ method: "POST", url: "/api/documents", cookies: s.adminCookie, payload: { workspaceId: s.ws.id, folderId: sub.json().id, title: "Deep", slug: "deep", content: "x" } });
    const u = await createUser("doc-only@t.co");
    await addMember(s.ws.id, u.id, "member");
    await grant(s.ws.id, "user", u.id, "document", d.json().id, "viewer");
    const tree = await req({ method: "GET", url: `/api/documents/tree?workspaceId=${s.ws.id}`, cookies: sessionFor(u.id) });
    check(treeSchema, 200, tree);
    const folders = tree.json().folders as Array<{ permission: string | null }>;
    expect(folders.some((f) => f.permission === null)).toBe(true);
  });

  it("error responses (status + shape)", async () => {
    const s = await baseScenario();
    const c = s.adminCookie;
    check(unauthorizedSchema, 401, await req({ method: "GET", url: "/api/me" }));
    check(validationErrorSchema, 400, await req({ method: "POST", url: "/api/documents", cookies: c, payload: { workspaceId: s.ws.id, folderId: s.folderId, title: "", slug: "" } }));
    check(notFoundSchema, 404, await req({ method: "GET", url: "/api/documents/does-not-exist", cookies: c }));
    check(conflictSchema, 409, await req({ method: "PUT", url: `/api/documents/${s.docId}`, cookies: c, payload: { baseVersion: "rev_stale", content: "x" } }));
    const { cookie } = await member(s.ws.id, "v@t.co", "member");
    await grant(s.ws.id, "user", (await prisma.user.findFirstOrThrow({ where: { email: "v@t.co" } })).id, "document", s.docId, "viewer");
    check(forbiddenSchema, 403, await req({ method: "DELETE", url: `/api/documents/${s.docId}`, cookies: cookie }));
  });
});
