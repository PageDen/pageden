import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";
import { drainScanWorker, setScanner } from "../../src/attachments/scanner.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); setScanner(async () => "clean"); });
afterEach(async () => { await drainScanWorker(); setScanner(undefined); });

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
    expect(data.status).toBe("scanning");
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
