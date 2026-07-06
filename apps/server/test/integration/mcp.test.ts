import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
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

describe("MCP agent access", () => {
  it("exposes llms.txt and handles MCP protocol helpers", async () => {
    const s = await agentToken(["search", "read"]);

    const unauthenticatedGet = await req({ method: "GET", url: "/mcp" });
    expect(unauthenticatedGet.statusCode).toBe(401);
    expect(unauthenticatedGet.headers["www-authenticate"]).toBe("Bearer");
    expect(unauthenticatedGet.json()).toMatchObject({
      error: "unauthorized",
      message: "Authentication required.",
    });

    const invalidAuthenticatedGet = await req({ method: "GET", url: "/mcp", headers: bearer("not-a-real-token") });
    expect(invalidAuthenticatedGet.statusCode).toBe(401);
    expect(invalidAuthenticatedGet.headers["www-authenticate"]).toBe("Bearer");

    const authenticatedGet = await req({ method: "GET", url: "/mcp", headers: bearer(s.token) });
    expect(authenticatedGet.statusCode).toBe(200);
    expect(authenticatedGet.headers["www-authenticate"]).toBeUndefined();
    expect(authenticatedGet.json()).toMatchObject({
      ok: true,
      transport: "streamable-http",
      authType: "token",
      tokenWorkspaceId: s.ws.id,
    });

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
    const tools = listed.json().result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("pageden_search");
    expect(toolNames).toContain("pageden_upsert_document_by_path");
    expect(toolNames).toContain("pageden_import_markdown_tree");
    expect(tools.find((t) => t.name === "pageden_add_section_comment")?.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.find((t) => t.name === "pageden_update_document")?.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(tools.find((t) => t.name === "pageden_review_plan")?.annotations).toMatchObject({
      title: "Review planning document",
      readOnlyHint: false,
      destructiveHint: false,
    });

    const search = await tool(s.token, "pageden_search", { workspaceId: s.ws.id, query: "Runbook" });
    expect(search.statusCode).toBe(200);
    const searchData = JSON.parse(search.json().result.content[0].text);
    expect(searchData.results[0].id).toBe(s.docId);
    const apiSearch = await req({
      method: "GET",
      url: `/api/search?workspaceId=${s.ws.id}&q=Runbook`,
      headers: bearer(s.token),
    });
    expect(searchData.results.map((r: { id: string }) => r.id)).toEqual(
      apiSearch.json().results.map((r: { id: string }) => r.id),
    );

    const read = await tool(s.token, "pageden_read_document", { documentId: s.docId });
    const readData = toolJson(read);
    expect(readData.content).toContain("# Runbook");
    expect(readData.body).toContain("# Runbook");
    expect(readData.headings[0]).toMatchObject({ level: 1, title: "Runbook", anchor: "runbook" });
    expect(readData.frontmatter).toEqual({});
    expect(readData.aiReadiness).toMatchObject({ status: expect.any(String), score: expect.any(Number) });
    expect(readData.aiReadiness.issues).toEqual(expect.any(Array));
    expect(readData.implementationReadiness.score).toEqual(expect.any(Number));
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

  it("supports agent-friendly read modes and records explicit agent reads", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);
    const created = toolJson(
      await tool(s.token, "pageden_create_document", {
        workspaceId: s.ws.id,
        folderId: s.folderId,
        title: "Agent Plan",
        slug: "agent-plan",
        content: "# Agent Plan\n\n## Scope\n\nOld text\n\n## Tests\n\n- pnpm test\n",
      }),
    );
    const firstRead = toolJson(await tool(s.token, "pageden_read_document", { documentId: created.id, headingsOnly: true }));
    expect(firstRead.headings.map((h: { title: string }) => h.title)).toContain("Scope");
    expect(firstRead.content).toBe("");
    expect(firstRead.body).toBeUndefined();

    const scopeSection = toolJson(await tool(s.token, "pageden_read_section", { documentId: created.id, anchor: "scope" }));
    expect(scopeSection.section).toMatchObject({ heading: "Scope", anchor: "scope" });
    expect(scopeSection.section.content).toContain("Old text");

    await tool(s.token, "pageden_update_document", {
      documentId: created.id,
      baseVersion: created.version,
      content: "# Agent Plan\n\n## Scope\n\nNew text\n\n## Tests\n\n- pnpm test\n",
    });
    const changed = toolJson(await tool(s.token, "pageden_read_document", { documentId: created.id, latestChangedSection: true }));
    expect(changed.latestChangedSection.section).toMatchObject({ heading: "Scope", anchor: "scope" });

    await tool(s.token, "pageden_update_document", {
      documentId: created.id,
      baseVersion: changed.version,
      content: "---\nstatus: draft\n---\n\n# Agent Plan\n\n## Scope\n\nNew text\n",
    });
    const canonicalOnly = await tool(s.token, "pageden_read_document", { documentId: created.id, canonicalOnly: true });
    expect(canonicalOnly.json().error.message).toMatch(/not canonical/i);

    const activity = toolJson(await tool(s.token, "pageden_activity_timeline", { limit: 20 }));
    const actions = activity.events.map((event: { action: string }) => event.action);
    // Agent reads are no longer persisted as audit events, so they don't appear
    // in the activity timeline; document changes still do.
    expect(actions).not.toContain("document_read_by_agent");
    expect(actions).toContain("document_marked_draft");
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

    const createFolder = await tool(s.token, "pageden_create_folder", {
      workspaceId: s.ws.id,
      name: "Blocked Folder",
      slug: "blocked-folder",
    });
    expect(createFolder.json().error.message).toMatch(/forbidden/i);
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

  it("creates folders and updates documents for editor-scoped agent tokens", async () => {
    const s = await agentToken(["search", "read", "create", "update", "append"]);

    const rootFolder = await tool(s.token, "pageden_create_folder", {
      workspaceId: s.ws.id,
      name: "Development",
      slug: "development",
    });
    const rootFolderData = toolJson(rootFolder);
    expect(rootFolderData.path).toBe("development");

    const childFolder = await tool(s.token, "pageden_create_folder", {
      workspaceId: s.ws.id,
      parentFolderId: rootFolderData.id,
      name: "Plans",
      slug: "plans",
    });
    const childFolderData = toolJson(childFolder);
    expect(childFolderData.path).toBe("development/plans");

    const duplicateFolder = await tool(s.token, "pageden_create_folder", {
      workspaceId: s.ws.id,
      parentFolderId: rootFolderData.id,
      name: "Plans",
      slug: "plans",
    });
    expect(duplicateFolder.json().error.message).toMatch(/already exists/i);

    const invalid = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: s.folderId,
      title: "Bad",
      slug: "Bad Slug",
    });
    expect(invalid.json().error.message).toMatch(/slug/i);

    const created = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: childFolderData.id,
      title: "Agent Draft",
      slug: "agent-draft",
      content: "# Agent Draft\n",
    });
    const createdData = toolJson(created);
    expect(createdData.path).toBe("development/plans/agent-draft.md");

    const createdByPath = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      path: "development/plans/path-created.md",
      title: "Path Created",
      content: "---\nstatus: superseded\nsupersededBy: engineering/runbook.md\n---\n\n# Path Created\n",
    });
    const createdByPathData = toolJson(createdByPath);
    expect(createdByPathData.path).toBe("development/plans/path-created.md");
    expect(await prisma.document.findUniqueOrThrow({ where: { id: createdByPathData.id } })).toMatchObject({ status: "superseded" });

    const canonical = await tool(s.token, "pageden_mark_document_canonical", {
      workspaceId: s.ws.id,
      path: "development/plans/path-created.md",
    });
    const canonicalData = toolJson(canonical);
    expect(canonicalData.ok).toBe(true);
    const canonicalDoc = await prisma.document.findUniqueOrThrow({ where: { id: createdByPathData.id } });
    expect(canonicalDoc.status).toBe("canonical");
    expect(canonicalDoc.supersededById).toBeNull();

    const deleted = await tool(s.token, "pageden_delete_document", {
      workspaceId: s.ws.id,
      path: "development/plans/path-created.md",
    });
    expect(toolJson(deleted).ok).toBe(true);
    expect(await prisma.document.findFirst({ where: { id: createdByPathData.id, deletedAt: null } })).toBeNull();

    const duplicate = await tool(s.token, "pageden_create_document", {
      workspaceId: s.ws.id,
      folderId: childFolderData.id,
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

  it("upserts documents by path and imports markdown trees with reports", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);

    const created = await tool(s.token, "pageden_upsert_document_by_path", {
      workspaceId: s.ws.id,
      path: "pageden-dev/docs/mcp-import-improvements-plan.md",
      title: "MCP Import Improvements Plan",
      content: "# MCP Import Improvements Plan\n\nInitial plan.\n",
      createFolders: true,
    });
    const createdData = toolJson(created);
    expect(createdData.action).toBe("created");
    expect(createdData.path).toBe("pageden-dev/docs/mcp-import-improvements-plan.md");
    expect(createdData.createdFolders.map((f: { path: string }) => f.path)).toEqual(["pageden-dev", "pageden-dev/docs"]);

    const unchanged = await tool(s.token, "pageden_upsert_document_by_path", {
      workspaceId: s.ws.id,
      path: "pageden-dev/docs/mcp-import-improvements-plan.md",
      title: "MCP Import Improvements Plan",
      content: "# MCP Import Improvements Plan\n\nInitial plan.\n",
      createFolders: true,
    });
    expect(toolJson(unchanged).action).toBe("skipped");

    const updated = await tool(s.token, "pageden_upsert_document_by_path", {
      workspaceId: s.ws.id,
      path: "pageden-dev/docs/mcp-import-improvements-plan.md",
      title: "MCP Import Improvements Plan",
      content: "# MCP Import Improvements Plan\n\nUpdated plan.\n",
      createFolders: true,
    });
    const updatedData = toolJson(updated);
    expect(updatedData.action).toBe("updated");

    const readUpdated = await tool(s.token, "pageden_read_document", {
      workspaceId: s.ws.id,
      path: "pageden-dev/docs/mcp-import-improvements-plan.md",
    });
    expect(toolJson(readUpdated).content).toContain("Updated plan.");

    const dryRun = await tool(s.token, "pageden_import_markdown_tree", {
      workspaceId: s.ws.id,
      rootPath: "pageden-dev",
      mode: "dry_run",
      files: [
        { path: "tasks/backend.md", content: "# Backend\n" },
        { path: "tasks/web-app.md", content: "# Web App\n" },
      ],
    });
    const dryRunData = toolJson(dryRun);
    expect(dryRunData.totals.createdDocuments).toBe(2);
    expect(dryRunData.createdDocuments).toContain("pageden-dev/tasks/backend.md");
    expect(await prisma.document.findFirst({ where: { workspaceId: s.ws.id, path: "pageden-dev/tasks/backend.md", deletedAt: null } })).toBeNull();

    const imported = await tool(s.token, "pageden_import_markdown_tree", {
      workspaceId: s.ws.id,
      rootPath: "pageden-dev",
      mode: "upsert",
      files: [
        { path: "tasks/backend.md", title: "Backend", content: "# Backend\n" },
        { path: "tasks/web-app.md", title: "Web App", content: "# Web App\n" },
      ],
    });
    const importedData = toolJson(imported);
    expect(importedData.totals.createdDocuments).toBe(2);
    expect(importedData.createdDocuments).toEqual(["pageden-dev/tasks/backend.md", "pageden-dev/tasks/web-app.md"]);

    const importedAgain = await tool(s.token, "pageden_import_markdown_tree", {
      workspaceId: s.ws.id,
      rootPath: "pageden-dev",
      mode: "upsert",
      files: [
        { path: "tasks/backend.md", title: "Backend", content: "# Backend\n" },
        { path: "tasks/web-app.md", title: "Web App", content: "# Web App\n" },
      ],
    });
    expect(toolJson(importedAgain).totals.skippedDocuments).toBe(2);
  });

  it("starts a multi-agent planning workflow and allows explicit draft section edits", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);

    const started = toolJson(
      await tool(s.token, "pageden_start_planning_workflow", {
        workspaceId: s.ws.id,
        path: "strategy/example-agent-plan.md",
        title: "Example Agent Plan",
        goal: "Draft and review the first implementation plan.",
        context: "Use comments for uncertainty and edits for accepted revisions.",
        leadAgentLabel: "agent-a",
        reviewAgentLabel: "agent-b",
        createFolders: true,
      }),
    );
    expect(started.action).toBe("created");
    expect(started.workflow).toBe("multi-agent-planning");
    expect(started.workflowStatus).toBe("drafting");

    const read = toolJson(await tool(s.token, "pageden_read_document", { documentId: started.id }));
    expect(read.status).toBe("draft");
    expect(read.frontmatter.workflow).toBe("multi-agent-planning");
    expect(read.frontmatter.workflowStatus).toBe("drafting");
    expect(read.content).toContain("## Proposed Plan");
    expect(read.content).toContain(":::decision");

    const blocked = await tool(s.token, "pageden_replace_section", {
      documentId: started.id,
      anchor: "proposed-plan",
      content: "- Ship the planning template.\n",
      baseVersion: started.version,
    });
    expect(blocked.json().error.message).toMatch(/not_canonical|not canonical/i);

    const replaced = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "proposed-plan",
        content: "- Ship the planning template.\n- Ask the reviewer for comments.\n",
        baseVersion: started.version,
        allowDraft: true,
      }),
    );
    expect(replaced.latestChangedSection.anchor).toBe("proposed-plan");

    const comment = toolJson(
      await tool(s.token, "pageden_add_section_comment", {
        documentId: started.id,
        sectionAnchor: "risks",
        body: "Clarify the rollback plan before final review.",
      }),
    );
    expect(comment.documentId).toBe(started.id);

    const claimed = toolJson(
      await tool(s.token, "pageden_claim_document", {
        documentId: started.id,
        note: "Reviewing plan round 0",
        ttlMinutes: 10,
      }),
    );
    expect(claimed.active).toBe(true);

    const packet = toolJson(await tool(s.token, "pageden_get_task_packet", { documentId: started.id }));
    expect(packet.packet.workflow).toMatchObject({
      workflow: "multi-agent-planning",
      workflowStatus: "drafting",
      reviewRound: 0,
      leadAgent: "agent-a",
      reviewAgent: "agent-b",
    });
    expect(packet.packet.recommendedAction).toBe("safe_edit");
    expect(packet.packet.openCommentsBySection).toEqual([
      {
        sectionAnchor: "risks",
        count: 1,
        comments: [{ id: comment.id, body: "Clarify the rollback plan before final review." }],
      },
    ]);
    expect(packet.packet.activeClaim).toMatchObject({ note: "Reviewing plan round 0" });
  });

  it("safely finalizes a multi-agent planning workflow only after blockers are clear", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);

    const started = toolJson(
      await tool(s.token, "pageden_start_planning_workflow", {
        workspaceId: s.ws.id,
        path: "strategy/finalize-agent-plan.md",
        title: "Finalize Agent Plan",
        goal: "Finalize a reviewed plan safely.",
        context: "Exercise the finalization guardrails.",
        leadAgentLabel: "agent-a",
        reviewAgentLabel: "agent-b",
        createFolders: true,
      }),
    );
    const assumptionsUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "assumptions",
        content: "- Review comments identify blockers before finalization.\n",
        baseVersion: started.version,
        allowDraft: true,
      }),
    );
    const planUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "proposed-plan",
        content: "- Resolve comments.\n- Confirm acceptance criteria.\n- Finalize the accepted plan.\n",
        baseVersion: assumptionsUpdated.version,
        allowDraft: true,
      }),
    );
    const risksUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "risks",
        content: "- Open comments can block canonical promotion.\n",
        baseVersion: planUpdated.version,
        allowDraft: true,
      }),
    );
    const openQuestionsCleared = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "open-questions",
        content: "None.\n",
        baseVersion: risksUpdated.version,
        allowDraft: true,
      }),
    );
    const criteriaUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "acceptance-criteria",
        content: "- Finalization refuses unresolved comments.\n- Finalization records an accepted decision.\n",
        baseVersion: openQuestionsCleared.version,
        allowDraft: true,
      }),
    );
    const finalPlanUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "final-plan",
        content: "Finalize the reviewed plan once blockers are resolved and acceptance criteria are satisfied.\n",
        baseVersion: criteriaUpdated.version,
        allowDraft: true,
      }),
    );
    const comment = toolJson(
      await tool(s.token, "pageden_add_section_comment", {
        documentId: started.id,
        sectionAnchor: "risks",
        body: "Confirm no blocking comments remain before finalization.",
      }),
    );

    const blocked = await tool(s.token, "pageden_finalize_plan", {
      documentId: started.id,
      baseVersion: finalPlanUpdated.version,
    });
    expect(blocked.json().error.message).toMatch(/unresolved comment/i);
    expect(blocked.json().error.data).toMatchObject({
      code: "plan_not_ready",
      blockers: [expect.stringMatching(/unresolved comment/i)],
    });

    const resolved = toolJson(await tool(s.token, "pageden_resolve_comment", { commentId: comment.id }));
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved).toMatchObject({
      resolvedByTokenId: s.tokenId,
      resolvedByLabel: "Codex agent (agent)",
    });
    const resolvedComments = toolJson(await tool(s.token, "pageden_list_comments", { documentId: started.id, includeResolved: true }));
    expect(resolvedComments.comments.find((row: { id: string }) => row.id === comment.id)).toMatchObject({
      resolvedByTokenId: s.tokenId,
      resolvedByLabel: "Codex agent (agent)",
    });

    const latest = toolJson(await tool(s.token, "pageden_read_document", { documentId: started.id }));
    const finalized = toolJson(
      await tool(s.token, "pageden_finalize_plan", {
        documentId: started.id,
        baseVersion: latest.version,
        owner: "agent-a",
      }),
    );
    expect(finalized.status).toBe("canonical");
    expect(finalized.workflowStatus).toBe("accepted");
    expect(finalized.decision).toMatchObject({ id: "final-plan", status: "accepted" });

    const canonicalRead = toolJson(await tool(s.token, "pageden_read_document", { documentId: started.id, canonicalOnly: true }));
    expect(canonicalRead.status).toBe("canonical");
    expect(canonicalRead.frontmatter.workflowStatus).toBe("accepted");
    expect(canonicalRead.content).toContain("id: final-plan");
    expect(canonicalRead.content).toContain("status: accepted");
  });

  it("submits comments-only planning reviews without update scope", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);
    const started = toolJson(
      await tool(s.token, "pageden_start_planning_workflow", {
        workspaceId: s.ws.id,
        path: "strategy/review-comments-only.md",
        title: "Review Comments Only",
        goal: "Let reviewers comment without editing.",
        leadAgentLabel: "agent-a",
        reviewAgentLabel: "agent-b",
        createFolders: true,
      }),
    );
    const tokenRes = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Reviewer", kind: "agent", workspaceId: s.ws.id, scopes: ["search", "read", "create"] },
    });
    expect(tokenRes.statusCode).toBe(201);
    const reviewerToken = tokenRes.json().token as string;
    const reviewerTokenId = tokenRes.json().id as string;
    await tool(s.token, "pageden_read_document", { documentId: started.id });

    const reviewed = toolJson(
      await req({
        method: "POST",
        url: "/mcp",
        headers: bearer(reviewerToken),
        cookies: s.adminCookie,
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "pageden_review_plan",
            arguments: {
              documentId: started.id,
              baseVersion: started.version,
              summary: "The plan is readable but needs rollback detail.",
              strengths: ["The goal is clear."],
              risks: ["Rollback path is not described."],
              blockingQuestions: ["Who approves production rollout?"],
            },
          },
        },
      }),
    );
    expect(reviewed.version).toBe(started.version);
    expect(reviewed.comments).toHaveLength(4);
    expect(reviewed.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorTokenId: reviewerTokenId,
          authorLabel: "Reviewer (agent)",
        }),
      ]),
    );
    expect(reviewed.changedSections).toEqual([]);
    expect(reviewed.recommendedWorkflowStatus).toBe("revision");

    const comments = toolJson(await tool(s.token, "pageden_list_comments", { documentId: started.id }));
    expect(comments.comments.map((comment: { body: string }) => comment.body)).toEqual(
      expect.arrayContaining([
        "Review summary: The plan is readable but needs rollback detail.",
        "Strength: The goal is clear.",
        "Risk: Rollback path is not described.",
        "Blocking question: Who approves production rollout?",
      ]),
    );
    const unread = toolJson(await tool(s.token, "pageden_my_unread", { workspaceId: s.ws.id }));
    expect(unread.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: started.id,
          version: started.version,
          lastReadVersion: started.version,
          unreadCommentCount: 4,
        }),
      ]),
    );
  });

  it("applies safe section edits and proposed decisions through planning reviews", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);
    const started = toolJson(
      await tool(s.token, "pageden_start_planning_workflow", {
        workspaceId: s.ws.id,
        path: "strategy/review-safe-edits.md",
        title: "Review Safe Edits",
        goal: "Allow low-risk reviewer edits.",
        leadAgentLabel: "agent-a",
        reviewAgentLabel: "agent-b",
        createFolders: true,
      }),
    );

    const reviewed = toolJson(
      await tool(s.token, "pageden_review_plan", {
        documentId: started.id,
        baseVersion: started.version,
        mode: "comments_and_safe_edits",
        summary: "Applied wording and proposed a deployment decision.",
        suggestedSectionEdits: [
          {
            anchor: "proposed-plan",
            content: "- Prepare the migration.\n- Run the deployment checklist.\n",
          },
        ],
        decisionRecommendations: [
          {
            id: "deployment-window",
            decision: "Use a weekday deployment window.",
            reason: "Support coverage is highest during weekdays.",
          },
        ],
      }),
    );
    expect(reviewed.version).not.toBe(started.version);
    expect(reviewed.changedSections).toEqual([{ anchor: "proposed-plan" }]);
    expect(reviewed.decisions[0]).toMatchObject({ id: "deployment-window", status: "proposed" });
    expect(reviewed.comments[0].body).toContain("Applied wording");
    expect(reviewed.reviewRound).toBe(1);

    const read = toolJson(await tool(s.token, "pageden_read_document", { documentId: started.id }));
    expect(read.frontmatter.reviewRound).toBe("1");
    expect(read.content).toContain("- Run the deployment checklist.");
    expect(read.content).toContain("id: deployment-window");
  });

  it("refuses to finalize while required planning sections are placeholders", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);
    const started = toolJson(
      await tool(s.token, "pageden_start_planning_workflow", {
        workspaceId: s.ws.id,
        path: "strategy/placeholder-final-plan.md",
        title: "Placeholder Final Plan",
        goal: "Reject placeholder final content.",
        leadAgentLabel: "agent-a",
        reviewAgentLabel: "agent-b",
        createFolders: true,
      }),
    );
    const assumptionsUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "assumptions",
        content: "- The placeholder guard runs before canonical promotion.\n",
        baseVersion: started.version,
        allowDraft: true,
      }),
    );
    const planUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "proposed-plan",
        content: "- Fill every required section except Final Plan.\n",
        baseVersion: assumptionsUpdated.version,
        allowDraft: true,
      }),
    );
    const risksUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "risks",
        content: "- Placeholder final content must not be promoted.\n",
        baseVersion: planUpdated.version,
        allowDraft: true,
      }),
    );
    const openQuestionsCleared = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "open-questions",
        content: "None.\n",
        baseVersion: risksUpdated.version,
        allowDraft: true,
      }),
    );
    const criteriaUpdated = toolJson(
      await tool(s.token, "pageden_replace_section", {
        documentId: started.id,
        anchor: "acceptance-criteria",
        content: "- Placeholder content blocks canonical promotion.\n",
        baseVersion: openQuestionsCleared.version,
        allowDraft: true,
      }),
    );

    const blocked = await tool(s.token, "pageden_finalize_plan", {
      documentId: started.id,
      baseVersion: criteriaUpdated.version,
    });
    expect(blocked.json().error.message).toMatch(/Final Plan section still contains placeholder content/i);
  });

  it("refuses stale planning reviews before adding comments", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);
    const started = toolJson(
      await tool(s.token, "pageden_start_planning_workflow", {
        workspaceId: s.ws.id,
        path: "strategy/review-stale.md",
        title: "Review Stale",
        goal: "Reject stale review submissions.",
        leadAgentLabel: "agent-a",
        reviewAgentLabel: "agent-b",
        createFolders: true,
      }),
    );
    await tool(s.token, "pageden_replace_section", {
      documentId: started.id,
      anchor: "proposed-plan",
      content: "- Move the version forward.\n",
      baseVersion: started.version,
      allowDraft: true,
    });

    const stale = await tool(s.token, "pageden_review_plan", {
      documentId: started.id,
      baseVersion: started.version,
      summary: "This should not be written.",
    });
    expect(stale.json().error.message).toMatch(/Conflict/);

    const comments = toolJson(await tool(s.token, "pageden_list_comments", { documentId: started.id }));
    expect(comments.comments).toEqual([]);
  });

  it("refuses to finalize when final-plan exists but is not accepted", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);
    const created = toolJson(
      await tool(s.token, "pageden_upsert_document_by_path", {
        workspaceId: s.ws.id,
        path: "strategy/proposed-final-plan.md",
        title: "Proposed Final Plan",
        createFolders: true,
        content: [
          "---",
          "status: draft",
          "docType: plan",
          "workflow: multi-agent-planning",
          "workflowStatus: final-review",
          "reviewRound: 1",
          "leadAgent: agent-a",
          "reviewAgent: agent-b",
          "---",
          "",
          "# Proposed Final Plan",
          "",
          "## Open Questions",
          "",
          "## Decisions",
          "",
          ":::decision",
          "id: final-plan",
          "status: proposed",
          "owner: agent-a",
          "",
          "decision: Proposed final plan.",
          "reason: It has not been accepted yet.",
          ":::",
          "",
          "## Acceptance Criteria",
          "",
          "- The final decision must be accepted.",
          "",
        ].join("\n"),
      }),
    );

    const res = await tool(s.token, "pageden_finalize_plan", {
      documentId: created.id,
      baseVersion: created.version,
    });
    expect(res.json().error.message).toMatch(/final-plan already exists but is not accepted/i);
  });

  it("does not allow allowDraft to edit superseded documents", async () => {
    const s = await agentToken(["search", "read", "create", "update"]);
    const created = toolJson(
      await tool(s.token, "pageden_upsert_document_by_path", {
        workspaceId: s.ws.id,
        path: "strategy/superseded-plan.md",
        title: "Superseded Plan",
        createFolders: true,
        content: "---\nstatus: superseded\n---\n\n# Superseded Plan\n\n## Notes\n\nOld text.\n",
      }),
    );
    const read = toolJson(await tool(s.token, "pageden_read_document", { documentId: created.id }));
    expect(read.status).toBe("superseded");

    const rejected = await tool(s.token, "pageden_replace_section", {
      documentId: created.id,
      anchor: "notes",
      content: "Should not write.\n",
      baseVersion: created.version,
      allowDraft: true,
    });
    expect(rejected.json().error.message).toMatch(/not_canonical|not canonical/i);
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
