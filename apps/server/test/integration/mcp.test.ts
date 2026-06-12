import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function agentToken(scopes: string[]) {
  const s = await baseScenario();
  const created = await req({
    method: "POST",
    url: "/api/tokens",
    cookies: s.adminCookie,
    payload: { name: "Codex agent", kind: "agent", workspaceId: s.ws.id, scopes },
  });
  expect(created.statusCode).toBe(201);
  return { ...s, token: created.json().token as string, tokenId: created.json().id as string };
}

async function rpc(token: string, method: string, params: unknown = {}) {
  return req({
    method: "POST",
    url: "/mcp",
    headers: bearer(token),
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  return rpc(token, "tools/call", { name, arguments: args });
}

function toolJson(response: Awaited<ReturnType<typeof tool>>) {
  return JSON.parse(response.json().result.content[0].text);
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("MCP agent access", () => {
  it("exposes llms.txt and handles MCP protocol helpers", async () => {
    const s = await agentToken(["search", "read"]);

    const llms = await req({ method: "GET", url: "/llms.txt" });
    expect(llms.statusCode).toBe(200);
    expect(llms.body).toContain("Pageden");
    expect(llms.body).toContain("pageden_search");

    const ping = await rpc(s.token, "ping");
    expect(ping.statusCode).toBe(200);
    expect(ping.json().result).toEqual({});

    const invalid = await req({ method: "POST", url: "/mcp", headers: bearer(s.token), payload: { id: 1 } });
    expect(invalid.json().error.message).toMatch(/invalid/i);

    const notification = await req({
      method: "POST",
      url: "/mcp",
      headers: bearer(s.token),
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(notification.statusCode).toBe(202);

    const batch = await req({
      method: "POST",
      url: "/mcp",
      headers: bearer(s.token),
      payload: [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toHaveLength(2);
  });

  it("supports initialize, tool listing, search, and read through a scoped agent token", async () => {
    const s = await agentToken(["search", "read"]);

    const init = await rpc(s.token, "initialize");
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe("pageden");

    const listed = await rpc(s.token, "tools/list");
    expect(listed.json().result.tools.map((t: { name: string }) => t.name)).toContain("pageden_search");

    const search = await tool(s.token, "pageden_search", { workspaceId: s.ws.id, query: "Runbook" });
    expect(search.statusCode).toBe(200);
    const searchData = JSON.parse(search.json().result.content[0].text);
    expect(searchData.results[0].id).toBe(s.docId);

    const read = await tool(s.token, "pageden_read_document", { documentId: s.docId });
    const readData = toolJson(read);
    expect(readData.content).toContain("# Runbook");
    expect(readData.body).toContain("# Runbook");
    expect(readData.headings[0]).toMatchObject({ level: 1, title: "Runbook", anchor: "runbook" });
    expect(readData.frontmatter).toEqual({});
    expect(readData.aiReadiness).toMatchObject({ status: expect.any(String), score: expect.any(Number) });
    expect(readData.aiReadiness.issues).toEqual(expect.any(Array));
  });

  it("chunks large document reads with offset/maxChars and paging metadata", async () => {
    const s = await agentToken(["search", "read", "create"]);
    const bigBody = `# Big Doc\n\n${"x".repeat(60_000)}`;
    const created = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: s.folderId,
      title: "Big Doc",
      slug: "big-doc",
      content: bigBody,
    });
    const createdData = toolJson(created);

    // Default read caps content at 50000 chars and reports paging metadata.
    // The write path may normalize content (e.g. trailing newline), so compare
    // against the stored size reported by the server rather than the input size.
    const first = toolJson(await tool(s.token, "pageden_read_document", { documentId: createdData.id }));
    expect(first.totalChars).toBeGreaterThanOrEqual(bigBody.length);
    expect(first.returnedChars).toBe(50_000);
    expect(first.content).toHaveLength(50_000);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(50_000);
    expect(first.body).toBeUndefined();
    expect(first.headings[0]).toMatchObject({ level: 1, title: "Big Doc" });

    // Following nextOffset returns the remainder and ends paging.
    const second = toolJson(
      await tool(s.token, "pageden_read_document", { documentId: createdData.id, offset: first.nextOffset }),
    );
    expect(second.offset).toBe(50_000);
    expect(second.returnedChars).toBe(first.totalChars - 50_000);
    expect(second.nextOffset).toBeNull();
    const reassembled = first.content + second.content;
    expect(reassembled).toHaveLength(first.totalChars);
    expect(reassembled.startsWith(bigBody)).toBe(true);

    // Explicit maxChars is honored; small docs remain untruncated with full metadata.
    const windowed = toolJson(
      await tool(s.token, "pageden_read_document", { documentId: createdData.id, offset: 2, maxChars: 5 }),
    );
    expect(windowed.content).toBe(bigBody.slice(2, 7));
    expect(windowed.truncated).toBe(true);

    const small = toolJson(await tool(s.token, "pageden_read_document", { documentId: s.docId }));
    expect(small.truncated).toBe(false);
    expect(small.nextOffset).toBeNull();
    expect(small.body).toContain("# Runbook");
  });

  it("reports AI-readiness issues that help agents judge document quality", async () => {
    const s = await agentToken(["search", "read", "create"]);
    const longBodyWithoutHeadings = Array.from(
      { length: 18 },
      (_, index) => `Paragraph ${index + 1} explains the process but still has no heading structure for agents.`,
    ).join("\n\n");

    const created = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: s.folderId,
      title: "Untitled",
      slug: "agent-readiness",
      content: `${longBodyWithoutHeadings}\n\nTODO confirm this section.\n\nRefer to [[Missing Decision]] and ![[diagram.png]].`,
    });
    const createdData = toolJson(created);
    const oldUpdatedAt = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000);
    await prisma.$executeRaw`UPDATE "Document" SET "updatedAt" = ${oldUpdatedAt} WHERE "id" = ${createdData.id}`;

    const read = await tool(s.token, "pageden_read_document", { documentId: createdData.id });
    const readData = toolJson(read);
    const codes = readData.aiReadiness.issues.map((issue: { code: string }) => issue.code);

    expect(readData.aiReadiness.status).toBe("needs_attention");
    expect(readData.aiReadiness.score).toBeLessThan(80);
    expect(codes).toEqual(expect.arrayContaining([
      "missing_title",
      "missing_headings",
      "unresolved_notes",
      "broken_wikilinks",
      "stale_document",
    ]));
    expect(JSON.stringify(readData.aiReadiness.issues)).toContain("Missing Decision");
    expect(JSON.stringify(readData.aiReadiness.issues)).not.toContain("diagram.png");
  });

  it("supports OAuth PKCE discovery and authorization for MCP clients", async () => {
    const s = await baseScenario();

    const protectedResource = await req({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(protectedResource.statusCode).toBe(200);
    expect(protectedResource.json().scopes_supported).toContain("read");

    const authorizationServer = await req({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    expect(authorizationServer.statusCode).toBe(200);
    expect(authorizationServer.json().code_challenge_methods_supported).toContain("S256");

    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "Codex",
      redirect_uri: "http://localhost:9876/callback",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      scope: "search read",
      workspace_id: s.ws.id,
      state: "state-1",
    });

    const authorize = await req({ method: "GET", url: `/oauth/authorize?${params.toString()}`, cookies: s.adminCookie });
    expect(authorize.statusCode).toBe(200);
    expect(authorize.body).toContain("Connect Codex");

    const approve = await req({ method: "GET", url: `/oauth/authorize?${params.toString()}&approve=1`, cookies: s.adminCookie });
    expect(approve.statusCode).toBe(302);
    const redirected = new URL(approve.headers.location as string);
    expect(redirected.searchParams.get("state")).toBe("state-1");
    const code = redirected.searchParams.get("code");
    expect(code).toBeTruthy();
    const pendingCode = await prisma.mcpOAuthCode.findFirstOrThrow({
      where: { workspaceId: s.ws.id, clientId: "Codex" },
    });
    expect(pendingCode.consumedAt).toBeNull();
    expect(pendingCode.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(pendingCode.codeHash).not.toBe(code);
    expect(pendingCode.codeChallenge).toBe(pkceChallenge(verifier));

    const token = await req({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:9876/callback",
        client_id: "Codex",
        code_verifier: verifier,
      },
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().token_type).toBe("Bearer");
    expect(token.json().scope).toBe("search read");
    const consumedCode = await prisma.mcpOAuthCode.findUniqueOrThrow({ where: { id: pendingCode.id } });
    expect(consumedCode.consumedAt).toBeTruthy();

    const listed = await rpc(token.json().access_token, "tools/list");
    expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).toContain("pageden_read_document");

    const reused = await req({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:9876/callback",
        client_id: "Codex",
        code_verifier: verifier,
      },
    });
    expect(reused.statusCode).toBe(400);
  });

  it("lists documents, recent changes, and MCP resources", async () => {
    const s = await agentToken(["search", "read"]);

    const listed = await tool(s.token, "pageden_list_documents", { workspaceId: s.ws.id });
    const listData = toolJson(listed);
    expect(listData.documents.map((doc: { id: string }) => doc.id)).toContain(s.docId);
    expect(listData.folders.map((folder: { id: string }) => folder.id)).toContain(s.folderId);

    const recent = await tool(s.token, "pageden_recent_changes", { workspaceId: s.ws.id, limit: 1 });
    const recentData = toolJson(recent);
    expect(recentData.documents).toHaveLength(1);
    expect(recentData.documents[0].id).toBe(s.docId);

    const resources = await rpc(s.token, "resources/list");
    const uri = resources.json().result.resources[0].uri as string;
    expect(uri).toContain("pageden://");

    const resource = await rpc(s.token, "resources/read", { uri });
    expect(resource.json().result.contents[0].text).toContain("# Runbook");

    const byPath = await tool(s.token, "pageden_read_document", { workspaceId: s.ws.id, path: "engineering/runbook.md" });
    expect(toolJson(byPath).id).toBe(s.docId);
  });

  it("provides agent-friendly workspace context tools", async () => {
    const s = await agentToken(["search", "read"]);

    const answer = await tool(s.token, "pageden_answer_from_docs", { workspaceId: s.ws.id, question: "Runbook", limit: 3 });
    const answerData = toolJson(answer);
    expect(answerData.instruction).toContain("citations");
    expect(answerData.citations[0]).toMatchObject({ id: s.docId, path: "engineering/runbook.md" });

    const related = await tool(s.token, "pageden_find_related_docs", { workspaceId: s.ws.id, documentId: s.docId, limit: 3 });
    const relatedData = toolJson(related);
    expect(relatedData.source.id).toBe(s.docId);
    expect(Array.isArray(relatedData.related)).toBe(true);

    const summary = await tool(s.token, "pageden_workspace_summary", { workspaceId: s.ws.id, limit: 3 });
    const summaryData = toolJson(summary);
    expect(summaryData.totals.documents).toBeGreaterThan(0);
    expect(summaryData.recentDocuments[0].id).toBe(s.docId);
  });

  it("blocks writes when the agent token is read-only", async () => {
    const s = await agentToken(["search", "read"]);

    const write = await tool(s.token, "pageden_update_document", {
      documentId: s.docId,
      baseVersion: s.version,
      content: "# nope\n",
    });
    expect(write.statusCode).toBe(200);
    expect(write.json().error.message).toMatch(/forbidden/i);

    const directWrite = await req({
      method: "PUT",
      url: `/api/documents/${s.docId}`,
      headers: bearer(s.token),
      payload: {
        baseVersion: s.version,
        content: "# still nope\n",
      },
    });
    expect(directWrite.statusCode).toBe(403);

    const create = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: s.folderId,
      title: "Blocked",
      slug: "blocked",
    });
    expect(create.json().error.message).toMatch(/forbidden/i);
  });

  it("writes append revisions as agent source when the token has append scope", async () => {
    const s = await agentToken(["search", "read", "append"]);

    const appended = await tool(s.token, "pageden_append_to_document", {
      documentId: s.docId,
      content: "Agent note\n",
    });
    expect(appended.statusCode).toBe(200);
    const data = JSON.parse(appended.json().result.content[0].text);
    expect(data.ok).toBe(true);

    const revision = await prisma.documentRevision.findUniqueOrThrow({ where: { id: data.version } });
    expect(revision.changeSource).toBe("agent");

    const read = await req({ method: "GET", url: `/api/documents/${s.docId}`, cookies: s.adminCookie });
    expect(read.json().content).toContain("Agent note");
  });

  it("creates and updates documents for editor-scoped agent tokens", async () => {
    const s = await agentToken(["search", "read", "create", "update", "append"]);

    const invalid = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: s.folderId,
      title: "Bad",
      slug: "Bad Slug",
    });
    expect(invalid.json().error.message).toMatch(/slug/i);

    const created = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: s.folderId,
      title: "Agent Draft",
      slug: "agent-draft",
      content: "# Agent Draft\n",
    });
    const createdData = toolJson(created);
    expect(createdData.path).toBe("engineering/agent-draft.md");

    const duplicate = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: s.folderId,
      title: "Agent Draft",
      slug: "agent-draft",
    });
    expect(duplicate.json().error.message).toMatch(/already exists/i);

    const stale = await tool(s.token, "pageden_update_document", {
      documentId: createdData.id,
      baseVersion: "not-a-version",
      content: "# stale\n",
    });
    expect(stale.json().error.message).toMatch(/conflict/i);

    const updated = await tool(s.token, "pageden_update_document", {
      documentId: createdData.id,
      baseVersion: createdData.version,
      title: "Agent Final",
      content: "# Agent Final\n",
    });
    const updatedData = toolJson(updated);
    expect(updatedData.ok).toBe(true);

    const revision = await prisma.documentRevision.findUniqueOrThrow({ where: { id: updatedData.version } });
    expect(revision.changeSource).toBe("agent");
  });

  it("reports JSON-RPC errors for unknown tools, bad resources, and wrong workspaces", async () => {
    const s = await agentToken(["search", "read"]);

    const unknownMethod = await rpc(s.token, "not/supported");
    expect(unknownMethod.json().error.message).toMatch(/unsupported/i);

    const unknownTool = await tool(s.token, "pageden_nope", {});
    expect(unknownTool.json().error.message).toMatch(/unknown tool/i);

    const badResource = await rpc(s.token, "resources/read", { uri: "https://example.com/nope" });
    expect(badResource.json().error.message).toMatch(/unsupported resource/i);

    const wrongWorkspace = await tool(s.token, "pageden_list_documents", { workspaceId: "other-workspace" });
    expect(wrongWorkspace.json().error.message).toMatch(/bound to another workspace/i);
  });
});
