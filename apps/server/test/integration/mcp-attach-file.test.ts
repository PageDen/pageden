import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";
import { signUploadGrant, verifyUploadGrant, UPLOAD_GRANT_TTL_SECONDS } from "../../src/attachments/upload-grant.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

type Scenario = Awaited<ReturnType<typeof baseScenario>>;

async function agentToken(s: Scenario, scopes: string[]) {
  const created = await req({
    method: "POST",
    url: "/api/tokens",
    cookies: s.adminCookie,
    payload: { name: "agent", kind: "agent", workspaceId: s.ws.id, scopes },
  });
  expect(created.statusCode).toBe(201);
  return created.json().token as string;
}

async function attach(token: string, args: Record<string, unknown>) {
  return req({
    method: "POST",
    url: "/mcp",
    headers: bearer(token),
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pageden_attach_file", arguments: args } },
  });
}

async function attachRequest(token: string, args: Record<string, unknown>) {
  return req({
    method: "POST",
    url: "/mcp",
    headers: bearer(token),
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pageden_request_attachment_upload", arguments: args } },
  });
}

const pdfBase64 = Buffer.from("%PDF-1.4\nfake-pdf-bytes\n%%EOF").toString("base64");

describe("pageden_attach_file MCP tool", () => {
  it("attaches a file to a document with the attachments scope", async () => {
    const s = await baseScenario();
    const token = await agentToken(s, ["attachments", "read"]);

    const res = await attach(token, {
      documentId: s.docId,
      filename: "Password Policy.pdf",
      contentType: "application/pdf",
      contentBase64: pdfBase64,
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.json().result.content[0].text);
    expect(data.filename).toBe("Password Policy.pdf");
    expect(data.contentType).toBe("application/pdf");
    expect(data.status).toBe("ready");
    expect(data.documentId).toBe(s.docId);
    expect(data.workspaceId).toBe(s.ws.id);

    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie });
    expect((list.json().attachments as Array<{ id: string }>).map((a) => a.id)).toContain(data.id);
  });

  it("rejects when the token lacks the attachments scope", async () => {
    const s = await baseScenario();
    const token = await agentToken(s, ["read"]);
    const res = await attach(token, {
      documentId: s.docId,
      filename: "x.pdf",
      contentType: "application/pdf",
      contentBase64: pdfBase64,
    });
    expect(res.json().result).toBeUndefined();
    expect(res.json().error).toBeTruthy();
  });

  it("rejects a disallowed content type", async () => {
    const s = await baseScenario();
    const token = await agentToken(s, ["attachments"]);
    const res = await attach(token, {
      documentId: s.docId,
      filename: "notes.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("hello").toString("base64"),
    });
    expect(res.json().error).toBeTruthy();
  });
});

describe("upload grant signing", () => {
  it("round-trips and rejects tampered or expired grants", () => {
    const grant = { workspaceId: "w1", documentId: "d1", userId: "u1", filename: "a.pdf", contentType: "application/pdf", maxBytes: 1000 };
    const token = signUploadGrant(grant);
    expect(verifyUploadGrant(token)).toMatchObject(grant);
    expect(verifyUploadGrant(token + "x")).toBeNull();
    expect(verifyUploadGrant("garbage")).toBeNull();
    const expired = signUploadGrant(grant, Date.now() - (UPLOAD_GRANT_TTL_SECONDS + 60) * 1000);
    expect(verifyUploadGrant(expired)).toBeNull();
  });
});

describe("pre-signed attachment upload (large files)", () => {
  it("issues an upload URL and accepts a raw binary PUT", async () => {
    const s = await baseScenario();
    const token = await agentToken(s, ["attachments", "read"]);

    const res = await attachRequest(token, {
      documentId: s.docId,
      filename: "Access Management.pdf",
      contentType: "application/pdf",
    });
    expect(res.statusCode).toBe(200);
    const grant = JSON.parse(res.json().result.content[0].text);
    expect(grant.method).toBe("PUT");
    expect(grant.maxBytes).toBeGreaterThan(1_000_000);

    const u = new URL(grant.uploadUrl);
    const put = await req({
      method: "PUT",
      url: u.pathname + u.search,
      headers: { "content-type": "application/pdf" },
      payload: Buffer.from("%PDF-1.4\nlarge-fake-pdf\n%%EOF"),
    });
    expect(put.statusCode).toBe(202);
    const att = put.json();
    expect(att.filename).toBe("Access Management.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(att.status).toBe("ready");

    const list = await req({ method: "GET", url: `/api/documents/${s.docId}/attachments`, cookies: s.adminCookie });
    expect((list.json().attachments as Array<{ id: string }>).map((a) => a.id)).toContain(att.id);
  });

  it("rejects an invalid grant on PUT", async () => {
    const put = await req({
      method: "PUT",
      url: "/api/attachments/upload?grant=not-a-real-grant",
      headers: { "content-type": "application/pdf" },
      payload: Buffer.from("data"),
    });
    expect(put.statusCode).toBe(403);
  });
});
