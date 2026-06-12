import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeAuditEvent } from "../audit.js";
import { isTokenScope, requireAuth, requireTokenScope, TOKEN_SCOPES, type AuthContext } from "../auth.js";
import { checksum as computeChecksum } from "../checksum.js";
import { lockFolderTree } from "../db.js";
import { env } from "../env.js";
import { isUniqueViolation } from "../errors.js";
import { atLeast, resolveDocumentRole, resolveFolderRole } from "../permissions/index.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import { buildDocumentPath, isValidSlug } from "../paths.js";
import { prisma } from "../prisma.js";
import { readContent, writeContent } from "../storage.js";
import { applyDocumentWrite, searchTextFor } from "../documents/routes.js";
import { createRawToken, hashToken } from "../tokens.js";
import { aiReadinessForDocument, documentContext } from "../ai-readiness.js";

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type McpContent = { type: "text"; text: string };

const MAX_QUERY = 256;
const DEFAULT_LIMIT = 10;
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;

const tools = [
  {
    name: "pageden_search",
    description: "Search readable documents in a Pageden workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Optional when this token is bound to one workspace." },
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "pageden_list_documents",
    description: "List folders and documents visible to the current token/user.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
    },
  },
  {
    name: "pageden_read_document",
    description:
      "Read a document by id or path. Large documents are returned in chunks: use offset/maxChars and the truncated/nextOffset response fields to page through the full content.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
        offset: { type: "number", minimum: 0, description: "Character offset to start reading from. Default 0." },
        maxChars: {
          type: "number",
          minimum: 1,
          maximum: 200000,
          description: "Maximum characters of content to return. Default 50000.",
        },
      },
    },
  },
  {
    name: "pageden_recent_changes",
    description: "List recently updated readable documents.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } },
    },
  },
  {
    name: "pageden_answer_from_docs",
    description: "Gather cited Pageden context for answering a question from workspace documents.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        question: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["question"],
    },
  },
  {
    name: "pageden_find_related_docs",
    description: "Find readable documents related to a document or topic.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: "pageden_workspace_summary",
    description: "Summarize the visible workspace structure and recent activity for an agent.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 20 } },
    },
  },
  {
    name: "pageden_create_document",
    description: "Create a document in a folder where the token/user can edit.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        folderId: { type: "string" },
        title: { type: "string" },
        slug: { type: "string" },
        content: { type: "string" },
      },
      required: ["folderId", "title", "slug"],
    },
  },
  {
    name: "pageden_update_document",
    description: "Replace a document's Markdown content using baseVersion conflict protection.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        baseVersion: { type: "string" },
        content: { type: "string" },
        title: { type: "string" },
      },
      required: ["documentId", "baseVersion", "content"],
    },
  },
  {
    name: "pageden_append_to_document",
    description: "Append Markdown to a document using the latest version.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        content: { type: "string" },
      },
      required: ["documentId", "content"],
    },
  },
];

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const params = Object.fromEntries(new URLSearchParams(String(body)));
    done(null, params);
  });

  app.get("/.well-known/oauth-protected-resource", async (request) => {
    const origin = requestOrigin(request);
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: TOKEN_SCOPES,
      resource_name: "Pageden MCP",
    };
  });

  app.get("/.well-known/oauth-authorization-server", async (request) => {
    const origin = requestOrigin(request);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: TOKEN_SCOPES,
    };
  });

  app.get<{
    Querystring: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      state?: string;
      scope?: string;
      workspace_id?: string;
      approve?: string;
    };
  }>("/oauth/authorize", async (request, reply) => {
    const auth = await requireAuth(request);
    const parsed = await parseAuthorizeRequest(request.query, auth.userId);
    if ("error" in parsed) return oauthRedirectError(reply, request.query.redirect_uri, request.query.state, parsed.error, parsed.description);

    if (request.query.approve === "1") {
      const jti = randomUUID();
      const code = createOAuthCode();
      const expiresAt = new Date(Date.now() + OAUTH_CODE_TTL_MS);
      await prisma.mcpOAuthCode.create({
        data: {
          jti,
          codeHash: hashToken(code, env.tokenHashSecret),
          userId: auth.userId,
          clientId: parsed.clientId,
          redirectUri: parsed.redirectUri,
          workspaceId: parsed.workspaceId,
          codeChallenge: parsed.codeChallenge,
          scopes: parsed.scopes,
          expiresAt,
        },
      });
      const redirect = new URL(parsed.redirectUri);
      redirect.searchParams.set("code", code);
      if (parsed.state) redirect.searchParams.set("state", parsed.state);
      await writeAuditEvent({
        workspaceId: parsed.workspaceId,
        userId: auth.userId,
        action: "mcp_oauth_approved",
        targetType: "workspace",
        targetId: parsed.workspaceId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        metadata: { clientId: parsed.clientId, scopes: parsed.scopes },
      });
      return reply.redirect(redirect.toString());
    }

    reply.type("text/html; charset=utf-8");
    return renderAuthorizePage({
      appName: parsed.clientId,
      workspaceName: parsed.workspaceName,
      scopes: parsed.scopes,
      approveUrl: authorizeApproveUrl(request),
    });
  });

  app.post<{
    Body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      code_verifier?: string;
    };
  }>("/oauth/token", async (request, reply) => {
    const body = request.body ?? {};
    if (body.grant_type !== "authorization_code") return oauthTokenError(reply, "unsupported_grant_type", "Only authorization_code is supported.");
    if (!body.code || !body.redirect_uri || !body.client_id || !body.code_verifier) {
      return oauthTokenError(reply, "invalid_request", "code, redirect_uri, client_id, and code_verifier are required.");
    }
    const codeHash = hashToken(body.code, env.tokenHashSecret);
    const persistedCode = await prisma.mcpOAuthCode.findUnique({ where: { codeHash } });
    if (
      !persistedCode ||
      !persistedCode.codeChallenge ||
      persistedCode.consumedAt ||
      persistedCode.expiresAt.getTime() <= Date.now() ||
      persistedCode.clientId !== body.client_id ||
      persistedCode.redirectUri !== body.redirect_uri
    ) {
      return oauthTokenError(reply, "invalid_grant", "Authorization code is invalid or expired.");
    }
    if (pkceChallenge(body.code_verifier) !== persistedCode.codeChallenge) {
      return oauthTokenError(reply, "invalid_grant", "PKCE verification failed.");
    }
    const rawToken = createRawToken();
    const token = await prisma.$transaction(async (tx) => {
      const consumed = await tx.mcpOAuthCode.updateMany({
        where: { id: persistedCode.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) return null;
      const created = await tx.apiToken.create({
        data: {
          userId: persistedCode.userId,
          name: `MCP OAuth: ${persistedCode.clientId.slice(0, 80)}`,
          kind: "agent",
          workspaceId: persistedCode.workspaceId,
          scopes: persistedCode.scopes,
          tokenHash: hashToken(rawToken, env.tokenHashSecret),
        },
        select: { id: true },
      });
      await writeAuditEvent(
        {
          workspaceId: persistedCode.workspaceId,
          userId: persistedCode.userId,
          action: "mcp_oauth_token_issued",
          targetType: "api_token",
          targetId: created.id,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
          metadata: { clientId: persistedCode.clientId, scopes: persistedCode.scopes },
        },
        tx,
      );
      return created;
    });
    if (!token) return oauthTokenError(reply, "invalid_grant", "Authorization code is invalid or expired.");
    return {
      access_token: rawToken,
      token_type: "Bearer",
      scope: persistedCode.scopes.join(" "),
    };
  });

  app.get("/.well-known/pageden-mcp.json", async (request) => {
    const origin = requestOrigin(request);
    return {
      name: "Pageden",
      description: "Team Markdown knowledge base for web, Obsidian, and AI agents.",
      mcp: {
        endpoint: `${origin}/mcp`,
        transport: "streamable-http-json-rpc",
        authorization: "Bearer agent token",
        localBridge: {
          command: "npx",
          args: ["@pageden/mcp"],
          env: ["PAGEDEN_URL", "PAGEDEN_TOKEN", "PAGEDEN_WORKSPACE"],
        },
      },
      connect: {
        mode: "oauth-authorization-code-pkce",
        authorizationUrl: `${origin}/oauth/authorize`,
        tokenUrl: `${origin}/oauth/token`,
        fallback: "Use the Pageden AI agents page to create, test, and copy a workspace-bound token when a client does not support OAuth.",
      },
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    };
  });

  app.get("/llms.txt", async (_request, reply) => {
    reply.type("text/plain; charset=utf-8");
    return [
      "# Pageden",
      "",
      "Pageden is a shared Markdown knowledge base for teams and AI agents.",
      "",
      "Connect agents to the MCP endpoint:",
      "- Endpoint: /mcp",
      "- Auth: Authorization: Bearer <agent token>",
      "- Recommended token type: agent, workspace-bound, scoped to search/read/update as needed.",
      "",
      "Primary tools:",
      tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n"),
      "",
    ].join("\n");
  });

  app.post("/mcp", async (request, reply) => {
    const auth = await requireAuth(request);
    const body = request.body;
    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((entry) => handleJsonRpc(entry, auth, request)));
      return responses.filter(Boolean);
    }
    const response = await handleJsonRpc(body, auth, request);
    if (!response) return reply.code(202).send();
    return response;
  });
}

async function handleJsonRpc(
  body: unknown,
  auth: AuthContext,
  request: FastifyRequest,
): Promise<unknown | null> {
  const msg = body as JsonRpcRequest;
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return rpcError(null, -32600, "Invalid JSON-RPC request.");
  }
  const id = msg.id ?? null;
  if (msg.method.startsWith("notifications/")) return null;

  try {
    if (msg.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "pageden", version: "0.1.0" },
      });
    }
    if (msg.method === "ping") return rpcResult(id, {});
    if (msg.method === "tools/list") return rpcResult(id, { tools });
    if (msg.method === "tools/call") {
      const params = asRecord(msg.params);
      const name = stringParam(params, "name");
      const args = asRecord(params.arguments ?? {});
      const result = await callTool(name, args, auth, request);
      return rpcResult(id, result);
    }
    if (msg.method === "resources/list") {
      const workspaceId = await resolveWorkspaceId(auth, undefined, request);
      const listed = await listDocuments(auth, workspaceId);
      return rpcResult(id, {
        resources: listed.documents.map((doc) => ({
          uri: `pageden://${workspaceId}/${doc.path}`,
          name: doc.title,
          mimeType: "text/markdown",
          description: doc.path,
        })),
      });
    }
    if (msg.method === "resources/read") {
      const params = asRecord(msg.params);
      const uri = stringParam(params, "uri");
      const parsed = parsePagedenUri(uri);
      const doc = await readDocument(auth, { workspaceId: parsed.workspaceId, path: parsed.path });
      return rpcResult(id, { contents: [{ uri, mimeType: "text/markdown", text: doc.content }] });
    }
    return rpcError(id, -32601, `Unsupported method: ${msg.method}`);
  } catch (error) {
    return rpcError(id, -32000, error instanceof Error ? error.message : "MCP tool failed.");
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  auth: AuthContext,
  request: FastifyRequest,
): Promise<{ content: McpContent[]; structuredContent?: unknown }> {
  let data: unknown;
  if (name === "pageden_search") data = await searchDocuments(auth, args, request);
  else if (name === "pageden_list_documents") data = await listDocuments(auth, await resolveWorkspaceId(auth, maybeString(args.workspaceId), request));
  else if (name === "pageden_read_document") data = await readDocumentChunked(auth, args);
  else if (name === "pageden_recent_changes") data = await recentChanges(auth, args, request);
  else if (name === "pageden_answer_from_docs") data = await answerFromDocs(auth, args, request);
  else if (name === "pageden_find_related_docs") data = await findRelatedDocs(auth, args, request);
  else if (name === "pageden_workspace_summary") data = await workspaceSummary(auth, args, request);
  else if (name === "pageden_create_document") data = await createDocument(auth, args, request);
  else if (name === "pageden_update_document") data = await updateDocument(auth, args, request);
  else if (name === "pageden_append_to_document") data = await appendToDocument(auth, args, request);
  else throw new Error(`Unknown tool: ${name}`);

  await writeAuditEvent({
    workspaceId: typeof data === "object" && data && "workspaceId" in data ? String((data as { workspaceId: unknown }).workspaceId) : undefined,
    userId: auth.userId,
    action: "mcp_tool_called",
    targetType: "mcp_tool",
    targetId: name,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { tokenId: auth.tokenId, tokenName: auth.tokenName, tokenKind: auth.tokenKind },
  });

  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

async function resolveWorkspaceId(auth: AuthContext, requested: string | undefined, request: FastifyRequest): Promise<string> {
  const routeWorkspace = typeof request.query === "object" && request.query ? maybeString((request.query as Record<string, unknown>).workspaceId) : undefined;
  const target = requested ?? routeWorkspace ?? auth.tokenWorkspaceId ?? undefined;
  if (auth.tokenWorkspaceId && target && target !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
  if (target) return target;
  const memberships = await prisma.workspaceMembership.findMany({ where: { userId: auth.userId }, select: { workspaceId: true }, take: 2 });
  if (memberships.length === 1) return memberships[0]!.workspaceId;
  throw new Error("workspaceId is required because this account can access multiple workspaces.");
}

async function listDocuments(auth: AuthContext, workspaceId: string) {
  requireTokenScope(auth, "read");
  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  const docs = await prisma.document.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { path: "asc" } });
  const visibleDocs = docs
    .map((doc) => ({ doc, role: resolver.documentRole(doc) }))
    .filter((entry) => entry.role !== null);
  const visibleFolderIds = new Set<string>();
  for (const folder of resolver.folders) {
    if (resolver.folderRole(folder.id)) visibleFolderIds.add(folder.id);
  }
  for (const { doc } of visibleDocs) {
    for (const id of resolver.ancestorFolderIds(doc.folderId)) visibleFolderIds.add(id);
  }
  return {
    workspaceId,
    folders: resolver.folders
      .filter((folder) => visibleFolderIds.has(folder.id))
      .map((folder) => ({ id: folder.id, parentFolderId: folder.parentFolderId, name: folder.name, path: folder.path })),
    documents: visibleDocs.map(({ doc, role }) => ({
      id: doc.id,
      folderId: doc.folderId,
      title: doc.title,
      path: doc.path,
      permission: role,
      version: doc.currentVersionId,
      checksum: doc.currentChecksum,
      updatedAt: doc.updatedAt.toISOString(),
    })),
  };
}

async function searchDocuments(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "search");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const query = stringParam(args, "query").trim().slice(0, MAX_QUERY);
  const limit = clampLimit(args.limit);
  if (!query) return { workspaceId, results: [] };

  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  const rows = await prisma.$queryRaw<Array<{ id: string; folderId: string; title: string; path: string; searchText: string | null; updatedAt: Date }>>`
    SELECT "id", "folderId", "title", "path", "searchText", "updatedAt"
    FROM "Document"
    WHERE "workspaceId" = ${workspaceId}
      AND "deletedAt" IS NULL
      AND strpos(lower(coalesce("title", '') || ' ' || coalesce("searchText", '')), lower(${query})) > 0
    ORDER BY
      (CASE WHEN strpos(lower(coalesce("title", '')), lower(${query})) > 0 THEN 0 ELSE 1 END) ASC,
      "updatedAt" DESC,
      "id" ASC
    LIMIT ${Math.min(limit * 4, 100)}`;
  const results = [];
  for (const row of rows) {
    const role = resolver.documentRole({ id: row.id, folderId: row.folderId });
    if (!role) continue;
    results.push({
      id: row.id,
      title: row.title,
      path: row.path,
      permission: role,
      updatedAt: row.updatedAt.toISOString(),
      snippet: makeSnippet(row.searchText, query),
    });
    if (results.length >= limit) break;
  }
  return { workspaceId, results };
}

async function readDocument(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "read");
  const documentId = maybeString(args.documentId);
  const path = maybeString(args.path);
  const workspaceId = maybeString(args.workspaceId) ?? auth.tokenWorkspaceId ?? undefined;
  if (!documentId && !path) throw new Error("documentId or path is required.");
  if (path && !workspaceId) throw new Error("workspaceId is required when reading by path.");
  const doc = await prisma.document.findFirst({
    where: documentId ? { id: documentId, deletedAt: null } : { workspaceId: workspaceId!, path: path!, deletedAt: null },
  });
  if (!doc) throw new Error("Document not found.");
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) throw new Error("Document not found.");
  let content = "";
  if (doc.currentVersionId) {
    const revision = await prisma.documentRevision.findUnique({ where: { id: doc.currentVersionId }, select: { storageKey: true } });
    if (revision) content = await readContent(revision.storageKey);
  }
  const context = documentContext(content);
  const readiness = await aiReadinessForDocument({
    workspaceId: doc.workspaceId,
    title: doc.title,
    updatedAt: doc.updatedAt,
    context,
  });
  return {
    workspaceId: doc.workspaceId,
    id: doc.id,
    folderId: doc.folderId,
    title: doc.title,
    path: doc.path,
    permission: role,
    version: doc.currentVersionId,
    checksum: doc.currentChecksum,
    updatedAt: doc.updatedAt.toISOString(),
    content,
    body: context.body,
    frontmatter: context.frontmatter,
    headings: context.headings,
    wikilinks: context.wikilinks,
    aiReadiness: readiness,
  };
}

const READ_CHUNK_DEFAULT = 50_000;
const READ_CHUNK_MAX = 200_000;

/**
 * MCP tool response for pageden_read_document: full read internally, but the returned
 * content is windowed by offset/maxChars so large documents are pageable by agents with
 * limited context. Internal callers (append/update) keep using readDocument directly.
 */
async function readDocumentChunked(auth: AuthContext, args: Record<string, unknown>) {
  const doc = await readDocument(auth, args);
  const rawOffset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
  const offset = Math.max(0, rawOffset);
  const rawMax = typeof args.maxChars === "number" && Number.isFinite(args.maxChars) ? Math.floor(args.maxChars) : READ_CHUNK_DEFAULT;
  const maxChars = Math.min(Math.max(1, rawMax), READ_CHUNK_MAX);
  const totalChars = doc.content.length;
  const chunk = doc.content.slice(offset, offset + maxChars);
  const truncated = offset > 0 || offset + chunk.length < totalChars;
  return {
    ...doc,
    content: chunk,
    // When truncated, body would duplicate oversized content; frontmatter/headings stay
    // available (computed from the full document) so agents can navigate.
    body: truncated ? undefined : doc.body,
    totalChars,
    offset,
    returnedChars: chunk.length,
    truncated,
    nextOffset: offset + chunk.length < totalChars ? offset + chunk.length : null,
  };
}

async function recentChanges(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const limit = clampLimit(args.limit);
  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  const docs = await prisma.document.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 100 });
  return {
    workspaceId,
    documents: docs
      .map((doc) => ({ doc, role: resolver.documentRole(doc) }))
      .filter((entry) => entry.role !== null)
      .slice(0, limit)
      .map(({ doc, role }) => ({
        id: doc.id,
        title: doc.title,
        path: doc.path,
        permission: role,
        version: doc.currentVersionId,
        updatedAt: doc.updatedAt.toISOString(),
      })),
  };
}

async function answerFromDocs(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "search");
  requireTokenScope(auth, "read");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const question = stringParam(args, "question").trim().slice(0, MAX_QUERY);
  const limit = Math.min(clampLimit(args.limit), 20);
  const search = await searchDocuments(auth, { workspaceId, query: question, limit }, request);
  const citations = [];
  for (const result of search.results.slice(0, limit)) {
    const doc = await readDocument(auth, { documentId: result.id });
    citations.push({
      id: doc.id,
      title: doc.title,
      path: doc.path,
      updatedAt: doc.updatedAt,
      headings: doc.headings,
      frontmatter: doc.frontmatter,
      snippet: result.snippet ?? excerpt(doc.content, question),
      excerpt: excerpt(doc.content, question),
    });
  }
  return {
    workspaceId,
    question,
    instruction: "Answer the user using only these citations. If the citations are not enough, say what is missing.",
    citations,
  };
}

async function findRelatedDocs(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "search");
  requireTokenScope(auth, "read");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const limit = Math.min(clampLimit(args.limit), 20);
  const explicitQuery = maybeString(args.query);
  let seedQuery = explicitQuery;
  let source: { id: string; title: string; path: string } | null = null;
  if (!seedQuery && (maybeString(args.documentId) || maybeString(args.path))) {
    const doc = await readDocument(auth, { workspaceId, documentId: maybeString(args.documentId), path: maybeString(args.path) });
    source = { id: doc.id, title: doc.title, path: doc.path };
    seedQuery = keywords(`${doc.title}\n${doc.content}`).slice(0, 8).join(" ");
  }
  if (!seedQuery) throw new Error("query, documentId, or path is required.");
  const search = await searchDocuments(auth, { workspaceId, query: seedQuery, limit: limit + 1 }, request);
  return {
    workspaceId,
    source,
    query: seedQuery,
    related: search.results.filter((doc) => doc.id !== source?.id).slice(0, limit),
  };
}

async function workspaceSummary(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const limit = Math.min(clampLimit(args.limit), 20);
  const listed = await listDocuments(auth, workspaceId);
  const recent = await recentChanges(auth, { workspaceId, limit }, request);
  const topFolders = listed.folders
    .map((folder) => ({
      ...folder,
      documentCount: listed.documents.filter((doc) => doc.path.startsWith(`${folder.path}/`)).length,
    }))
    .sort((a, b) => b.documentCount - a.documentCount || a.path.localeCompare(b.path))
    .slice(0, limit);
  return {
    workspaceId,
    totals: { folders: listed.folders.length, documents: listed.documents.length },
    topFolders,
    recentDocuments: recent.documents,
  };
}

async function createDocument(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "create");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const folderId = stringParam(args, "folderId");
  const title = stringParam(args, "title").trim();
  const slug = stringParam(args, "slug").trim().toLowerCase();
  const content = maybeString(args.content) ?? "";
  if (!title) throw new Error("title is required.");
  if (!slug || !isValidSlug(slug)) throw new Error("slug must be lowercase letters, numbers, and hyphens.");
  const folder = await prisma.folder.findFirst({ where: { id: folderId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!folder) throw new Error("Folder not found.");
  const folderRole = await resolveFolderRole(auth.userId, folder.id);
  if (folderRole === null) throw new Error("Folder not found.");
  if (!atLeast(folderRole, "editor")) throw new Error("Forbidden.");

  const sum = computeChecksum(content);
  const { storageKey } = await writeContent(content, workspaceId);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockFolderTree(tx, workspaceId);
      const lockedFolder = await tx.folder.findFirst({ where: { id: folder.id, workspaceId, deletedAt: null }, select: { path: true } });
      if (!lockedFolder) throw new Error("Folder not found.");
      const path = buildDocumentPath(lockedFolder.path, slug);
      const existing = await tx.document.findFirst({ where: { folderId, slug, deletedAt: null }, select: { id: true } });
      if (existing) throw new Error("A document with this slug already exists in the folder.");
      const doc = await tx.document.create({
        data: { workspaceId, folderId, title, slug, path, createdById: auth.userId, updatedById: auth.userId },
      });
      const revision = await tx.documentRevision.create({
        data: { documentId: doc.id, versionNumber: 1, storageKey, checksum: sum, createdById: auth.userId, changeSource: "agent" },
      });
      const updated = await tx.document.update({
        where: { id: doc.id },
        data: { currentVersionId: revision.id, currentChecksum: sum, searchText: searchTextFor(content) },
      });
      await writeAuditEvent(
        {
          workspaceId,
          userId: auth.userId,
          action: "document_created_by_agent",
          targetType: "document",
          targetId: doc.id,
          metadata: { path, version: revision.id, tokenId: auth.tokenId, tokenName: auth.tokenName },
        },
        tx,
      );
      return { workspaceId, id: doc.id, title, path: updated.path, version: revision.id, checksum: sum, updatedAt: updated.updatedAt.toISOString() };
    });
    return result;
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A document with this slug or path already exists.", { cause: error });
    throw error;
  }
}

async function updateDocument(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "update");
  const documentId = stringParam(args, "documentId");
  const baseVersion = stringParam(args, "baseVersion");
  const content = stringParam(args, "content");
  const title = maybeString(args.title)?.trim();
  await assertTokenOwnsDocument(auth, documentId);
  const outcome = await applyDocumentWrite({ documentId, userId: auth.userId, baseVersion, content, title, changeSource: "agent" });
  if (!outcome.ok) throw new Error(outcome.status === "conflict" ? `Conflict. Current version is ${outcome.currentVersion}.` : outcome.status ?? "Write failed.");
  await writeAuditEvent({
    workspaceId: await workspaceIdForDocument(documentId),
    userId: auth.userId,
    action: "document_updated_by_agent",
    targetType: "document",
    targetId: documentId,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { tokenId: auth.tokenId, tokenName: auth.tokenName, version: outcome.version },
  });
  return { workspaceId: await workspaceIdForDocument(documentId), ...outcome, updatedAt: outcome.updatedAt?.toISOString() };
}

async function appendToDocument(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "append");
  const current = await readDocument(auth, { documentId: stringParam(args, "documentId") });
  const addition = stringParam(args, "content");
  const base = current.content.endsWith("\n") || current.content.length === 0 ? current.content : `${current.content}\n`;
  await assertTokenOwnsDocument(auth, current.id);
  const outcome = await applyDocumentWrite({
    documentId: current.id,
    userId: auth.userId,
    baseVersion: current.version ?? "",
    content: `${base}${addition}`,
    changeSource: "agent",
  });
  if (!outcome.ok) throw new Error(outcome.status === "conflict" ? `Conflict. Current version is ${outcome.currentVersion}.` : outcome.status ?? "Append failed.");
  const workspaceId = await workspaceIdForDocument(current.id);
  await writeAuditEvent({
    workspaceId,
    userId: auth.userId,
    action: "document_appended_by_agent",
    targetType: "document",
    targetId: current.id,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { tokenId: auth.tokenId, tokenName: auth.tokenName, version: outcome.version },
  });
  return { workspaceId, ...outcome, updatedAt: outcome.updatedAt?.toISOString() };
}

async function assertTokenOwnsDocument(auth: AuthContext, documentId: string): Promise<void> {
  if (!auth.tokenWorkspaceId) return;
  const workspaceId = await workspaceIdForDocument(documentId);
  if (workspaceId !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
}

async function workspaceIdForDocument(documentId: string): Promise<string> {
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, select: { workspaceId: true } });
  if (!doc) throw new Error("Document not found.");
  return doc.workspaceId;
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = maybeString(params[key]);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function clampLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? DEFAULT_LIMIT);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 50) : DEFAULT_LIMIT;
}

function makeSnippet(searchText: string | null, query: string): string | null {
  if (!searchText) return null;
  const idx = searchText.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - 70);
  const end = Math.min(searchText.length, idx + query.length + 70);
  return `${start > 0 ? "... " : ""}${searchText.slice(start, end).replace(/\s+/g, " ").trim()}${end < searchText.length ? " ..." : ""}`;
}

function excerpt(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const idx = compact.toLowerCase().indexOf(query.toLowerCase());
  const start = idx === -1 ? 0 : Math.max(0, idx - 220);
  const end = idx === -1 ? 420 : Math.min(compact.length, idx + query.length + 220);
  return `${start > 0 ? "... " : ""}${compact.slice(start, end)}${end < compact.length ? " ..." : ""}`;
}

function keywords(content: string): string[] {
  const stop = new Set(["about", "after", "again", "also", "because", "before", "could", "document", "from", "have", "into", "markdown", "pageden", "should", "that", "their", "there", "these", "this", "with", "would"]);
  const counts = new Map<string, number>();
  for (const word of content.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word]) => word);
}

function parsePagedenUri(uri: string): { workspaceId: string; path: string } {
  const parsed = new URL(uri);
  if (parsed.protocol !== "pageden:") throw new Error("Unsupported resource URI.");
  return { workspaceId: parsed.hostname, path: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) };
}

async function parseAuthorizeRequest(
  query: {
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    state?: string;
    scope?: string;
    workspace_id?: string;
  },
  userId: string,
): Promise<
  | {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      state?: string;
      scopes: string[];
      workspaceId: string;
      workspaceName: string;
    }
  | { error: string; description: string }
> {
  if (query.response_type !== "code") return { error: "unsupported_response_type", description: "Only response_type=code is supported." };
  if (!query.client_id || !query.redirect_uri || !query.code_challenge || !query.workspace_id) {
    return { error: "invalid_request", description: "client_id, redirect_uri, code_challenge, and workspace_id are required." };
  }
  if (query.code_challenge_method !== "S256") return { error: "invalid_request", description: "Only code_challenge_method=S256 is supported." };
  const redirect = parseRedirectUri(query.redirect_uri);
  if (!redirect) return { error: "invalid_request", description: "redirect_uri must be http(s), loopback, or localhost." };
  const scopes = (query.scope ?? "search read").split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  const invalidScope = scopes.find((scope) => !isTokenScope(scope));
  if (!scopes.length || invalidScope) return { error: "invalid_scope", description: "Requested scope is not supported." };
  const workspace = await prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId: query.workspace_id },
    select: { workspace: { select: { id: true, name: true } } },
  });
  if (!workspace) return { error: "access_denied", description: "Choose a workspace you belong to." };
  return {
    clientId: query.client_id.slice(0, 120),
    redirectUri: redirect.toString(),
    codeChallenge: query.code_challenge,
    state: query.state,
    scopes,
    workspaceId: workspace.workspace.id,
    workspaceName: workspace.workspace.name,
  };
}

function parseRedirectUri(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return url;
    return null;
  } catch {
    return null;
  }
}

function oauthRedirectError(
  reply: { code: (status: number) => { send: (body: unknown) => unknown }; redirect: (url: string) => unknown },
  redirectUri: string | undefined,
  state: string | undefined,
  error: string,
  description: string,
) {
  const redirect = redirectUri ? parseRedirectUri(redirectUri) : null;
  if (!redirect) return reply.code(400).send({ error, error_description: description });
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("error_description", description);
  if (state) redirect.searchParams.set("state", state);
  return reply.redirect(redirect.toString());
}

function oauthTokenError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: string, description: string) {
  return reply.code(400).send({ error, error_description: description });
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function createOAuthCode(): string {
  return `pm_oauth_${randomBytes(32).toString("base64url")}`;
}

function requestOrigin(request: FastifyRequest): string {
  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string" ? request.headers["x-forwarded-proto"].split(",")[0]?.trim() : null;
  const proto = forwardedProto || request.protocol;
  return `${proto}://${request.hostname}`;
}

function authorizeApproveUrl(request: FastifyRequest): string {
  const url = new URL(request.url, requestOrigin(request));
  url.searchParams.set("approve", "1");
  return `${url.pathname}${url.search}`;
}

function renderAuthorizePage({ appName, workspaceName, scopes, approveUrl }: { appName: string; workspaceName: string; scopes: string[]; approveUrl: string }) {
  const escapedApp = escapeHtml(appName);
  const escapedWorkspace = escapeHtml(workspaceName);
  const scopeList = scopes.map((scope) => `<li>${escapeHtml(scopeLabel(scope))}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize ${escapedApp} - Pageden</title>
  <style>
    body{margin:0;background:#f8fafc;color:#0f172a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{min-height:100vh;display:grid;place-items:center;padding:24px}
    section{width:min(520px,100%);background:#fff;border:1px solid #dbe3ef;border-radius:16px;box-shadow:0 20px 60px rgba(15,23,42,.08);padding:28px}
    .brand{display:flex;align-items:center;gap:12px;font-weight:700}.logo{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#f45107;color:#fff}
    h1{font-size:28px;margin:28px 0 8px}p{color:#64748b;line-height:1.55}ul{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 14px 14px 32px;color:#334155}
    a{display:flex;align-items:center;justify-content:center;height:48px;border-radius:10px;background:#f45107;color:#fff;text-decoration:none;font-weight:700;margin-top:22px}
    small{display:block;margin-top:14px;color:#94a3b8;text-align:center}
  </style>
</head>
<body>
  <main>
    <section>
      <div class="brand"><span class="logo">P</span><span>Pageden</span></div>
      <h1>Connect ${escapedApp}</h1>
      <p>This will let <strong>${escapedApp}</strong> access the <strong>${escapedWorkspace}</strong> workspace through Pageden MCP.</p>
      <ul>${scopeList}</ul>
      <a href="${escapeHtml(approveUrl)}">Approve connection</a>
      <small>You can revoke this agent key from Pageden at any time.</small>
    </section>
  </main>
</body>
</html>`;
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    search: "Search documents",
    read: "Read document content",
    create: "Create documents",
    update: "Update documents",
    append: "Append to documents",
    attachments: "Read and upload attachments",
  };
  return labels[scope] ?? scope;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
