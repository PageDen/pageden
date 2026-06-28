import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isUniqueViolation, validationError } from "../errors.js";
import { requireAuth } from "../auth.js";
import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { resolveDocumentRole, resolveFolderRole, atLeast } from "../permissions/index.js";
import { searchDocuments, clampSearchLimit } from "../search/service.js";
import { readContent, writeContent, readBlob } from "../storage.js";
import { applyDocumentWrite, metadataFromContent, searchTextFor } from "../documents/routes.js";
import { createDocumentAttachment, MAX_ATTACHMENT_BYTES } from "../attachments/routes.js";
import { buildDocumentPath, isValidSlug } from "../paths.js";
import { checksum as computeChecksum } from "../checksum.js";
import { lockFolderTree } from "../db.js";

const CONNECT_TTL_MS = 15 * 60 * 1000;
const KEY_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const CLIENT_ID_PREFIX = "pd_int_";
const SECRET_PREFIX = "pd_secret_";
const CONNECT_TOKEN_PREFIX = "pd_connect_";
const MAX_NAME = 120;
const MAX_EXTERNAL_ACCOUNT_ID = 128;
const MAX_EXTERNAL_USERNAME = 128;
const RUNTIME_MODES = new Set(["rest", "openresponses", "custom"]);
const ALLOWED_SCOPES = new Set(["connect:write", "links:read", "documents:read", "documents:write", "comments:write"]);

type IntegrationAuth = {
  id: string;
  workspaceId: string;
  providerKey: string;
  runtimeMode: string;
  name: string;
  scopes: string[];
};

function parsePath(rawPath: string): { folderPath: string; slug: string } | null {
  const normalized = rawPath.replace(/^\//, "").replace(/\.md$/, "").trim();
  if (!normalized) return null;
  const lastSlash = normalized.lastIndexOf("/");
  const slug = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  const folderPath = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
  if (!isValidSlug(slug)) return null;
  return { folderPath, slug };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseBasicAuth(request: FastifyRequest): { clientId: string; clientSecret: string } | null {
  const header = request.headers.authorization;
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  const encoded = header.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  const clientId = decoded.slice(0, separator);
  const clientSecret = decoded.slice(separator + 1);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function requireIntegrationAuth(request: FastifyRequest, reply: FastifyReply, requiredScope: string): Promise<IntegrationAuth | null> {
  const credentials = parseBasicAuth(request);
  if (!credentials) {
    reply.code(401).send({ error: "unauthorized", message: "Integration credentials required." });
    return null;
  }
  const integration = await prisma.workspaceIntegration.findUnique({
    where: { clientId: credentials.clientId },
    select: { id: true, workspaceId: true, providerKey: true, runtimeMode: true, name: true, clientSecretHash: true, scopes: true, revokedAt: true },
  });
  if (!integration || integration.revokedAt || !safeEqual(sha256(credentials.clientSecret), integration.clientSecretHash)) {
    reply.code(401).send({ error: "unauthorized", message: "Integration credentials required." });
    return null;
  }
  if (!integration.scopes.includes(requiredScope)) {
    reply.code(403).send({ error: "forbidden", message: `Integration requires ${requiredScope} scope.` });
    return null;
  }
  await prisma.workspaceIntegration.update({ where: { id: integration.id }, data: { lastUsedAt: new Date() } });
  return {
    id: integration.id,
    workspaceId: integration.workspaceId,
    providerKey: integration.providerKey,
    runtimeMode: integration.runtimeMode,
    name: integration.name,
    scopes: integration.scopes,
  };
}

async function requireWorkspaceAdmin(request: FastifyRequest, reply: FastifyReply, workspaceId: string): Promise<string | null> {
  const auth = await requireAuth(request);
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: auth.userId } },
    select: { role: true },
  });
  if (membership?.role !== "admin") {
    reply.code(404).send({ error: "not_found", message: "Workspace not found." });
    return null;
  }
  return auth.userId;
}

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return KEY_RE.test(normalized) ? normalized : null;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NAME ? trimmed : null;
}

function normalizeRuntimeMode(value: unknown): string | null {
  if (value === undefined) return "rest";
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return RUNTIME_MODES.has(normalized) ? normalized : null;
}

function normalizeScopes(value: unknown): string[] | null {
  if (value === undefined) return ["connect:write", "links:read"];
  if (!Array.isArray(value)) return null;
  const scopes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ALLOWED_SCOPES.has(item)) return null;
    if (!scopes.includes(item)) scopes.push(item);
  }
  return scopes;
}

function normalizeExternalAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_EXTERNAL_ACCOUNT_ID ? id : null;
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : undefined;
}

function parseIntegrationBody(body: unknown):
  | { providerKey: string; runtimeMode: string; name: string; scopes: string[] }
  | { fields: Record<string, string> } {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const providerKey = normalizeKey(input.providerKey);
  const runtimeMode = normalizeRuntimeMode(input.runtimeMode);
  const name = normalizeName(input.name);
  const scopes = normalizeScopes(input.scopes);
  const fields: Record<string, string> = {};
  if (!providerKey) fields.providerKey = "Expected a provider key like openclaw or custom-agent.";
  if (!runtimeMode) fields.runtimeMode = "Expected runtimeMode to be rest, openresponses, or custom.";
  if (!name) fields.name = "Expected a non-empty name up to 120 characters.";
  if (!scopes) fields.scopes = "Expected an array of valid scopes.";
  if (Object.keys(fields).length > 0) return { fields };
  return { providerKey: providerKey!, runtimeMode: runtimeMode!, name: name!, scopes: scopes! };
}

function parseExternalIdentity(inputValue: unknown):
  | { externalProvider: string; externalAccountId: string; externalUsername?: string | null; externalMetadata?: object | null }
  | { fields: Record<string, string> } {
  const input = inputValue && typeof inputValue === "object" ? (inputValue as Record<string, unknown>) : {};
  const externalProvider = normalizeKey(input.externalProvider);
  const externalAccountId = normalizeExternalAccountId(input.externalAccountId);
  const externalUsername = normalizeOptionalString(input.externalUsername, MAX_EXTERNAL_USERNAME);
  const externalMetadata =
    input.externalMetadata === undefined || input.externalMetadata === null
      ? null
      : typeof input.externalMetadata === "object" && !Array.isArray(input.externalMetadata)
        ? (input.externalMetadata as object)
        : undefined;
  const fields: Record<string, string> = {};
  if (!externalProvider) fields.externalProvider = "Expected an external provider like discord or openclaw.";
  if (!externalAccountId) fields.externalAccountId = "Expected a stable external account id.";
  if (externalUsername === undefined && "externalUsername" in input) fields.externalUsername = "Expected a short display name.";
  if (externalMetadata === undefined) fields.externalMetadata = "Expected an object.";
  if (Object.keys(fields).length > 0) return { fields };
  return { externalProvider: externalProvider!, externalAccountId: externalAccountId!, externalUsername, externalMetadata };
}

function integrationDto(integration: {
  id: string;
  workspaceId: string;
  providerKey: string;
  runtimeMode: string;
  name: string;
  clientId: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: integration.id,
    workspaceId: integration.workspaceId,
    providerKey: integration.providerKey,
    runtimeMode: integration.runtimeMode,
    name: integration.name,
    clientId: integration.clientId,
    scopes: integration.scopes,
    createdAt: integration.createdAt.toISOString(),
    updatedAt: integration.updatedAt.toISOString(),
    lastUsedAt: integration.lastUsedAt ? integration.lastUsedAt.toISOString() : null,
    revokedAt: integration.revokedAt ? integration.revokedAt.toISOString() : null,
  };
}

function linkDto(link: {
  id: string;
  workspaceId: string;
  integrationId: string;
  userId?: string;
  externalProvider: string;
  externalAccountId: string;
  externalUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  integration?: { id: string; providerKey: string; runtimeMode: string; name: string } | null;
  workspace?: { id: string; name: string; slug: string } | null;
}) {
  return {
    id: link.id,
    workspaceId: link.workspaceId,
    integrationId: link.integrationId,
    externalProvider: link.externalProvider,
    externalAccountId: link.externalAccountId,
    externalUsername: link.externalUsername,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
    lastUsedAt: link.lastUsedAt ? link.lastUsedAt.toISOString() : null,
    revokedAt: link.revokedAt ? link.revokedAt.toISOString() : null,
    ...(link.integration ? { integration: link.integration } : {}),
    ...(link.workspace ? { workspace: link.workspace } : {}),
  };
}

async function confirmConnectSession(input: { sessionId: string; rawToken: string; userId: string }) {
  const now = new Date();
  const tokenHash = sha256(input.rawToken);

  return prisma.$transaction(async (tx) => {
    const session = await tx.externalConnectSession.findUnique({
      where: { id: input.sessionId },
      select: {
        id: true,
        workspaceId: true,
        integrationId: true,
        tokenHash: true,
        externalProvider: true,
        externalAccountId: true,
        externalUsername: true,
        externalMetadata: true,
        expiresAt: true,
        usedAt: true,
        integration: { select: { name: true } },
      },
    });
    if (!session || session.tokenHash !== tokenHash || session.usedAt || session.expiresAt <= now) return { status: "not_found" as const };

    const membership = await tx.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: session.workspaceId, userId: input.userId } },
      select: { userId: true },
    });
    if (!membership) return { status: "not_member" as const };

    const existing = await tx.externalAccountLink.findUnique({
      where: {
        integrationId_externalProvider_externalAccountId: {
          integrationId: session.integrationId,
          externalProvider: session.externalProvider,
          externalAccountId: session.externalAccountId,
        },
      },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (existing && existing.userId !== input.userId && !existing.revokedAt) {
      return { status: "linked_elsewhere" as const, externalProvider: session.externalProvider };
    }

    let link;
    if (existing) {
      link = await tx.externalAccountLink.update({
        where: { id: existing.id },
        data: {
          userId: input.userId,
          externalUsername: session.externalUsername,
          externalMetadata: session.externalMetadata ?? undefined,
          revokedAt: null,
          lastUsedAt: now,
        },
      });
    } else {
      try {
        link = await tx.externalAccountLink.create({
          data: {
            workspaceId: session.workspaceId,
            integrationId: session.integrationId,
            userId: input.userId,
            externalProvider: session.externalProvider,
            externalAccountId: session.externalAccountId,
            externalUsername: session.externalUsername,
            externalMetadata: session.externalMetadata ?? undefined,
            lastUsedAt: now,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { status: "linked_elsewhere" as const, externalProvider: session.externalProvider };
        throw error;
      }
    }

    await tx.externalConnectSession.update({ where: { id: session.id }, data: { usedAt: now } });
    return { status: "linked" as const, link };
  });
}

function sendConfirmResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof confirmConnectSession>>,
  options: { html?: boolean } = {},
) {
  if (result.status === "not_found") {
    if (options.html) return reply.code(404).type("text/html").send("<h1>Connect link expired</h1>");
    return reply.code(404).send({ error: "not_found", message: "Connect session not found or expired." });
  }
  if (result.status === "not_member") {
    if (options.html) return reply.code(403).type("text/html").send("<h1>Workspace membership required</h1>");
    return reply.code(403).send({ error: "forbidden", message: "You must be a workspace member to link this account." });
  }
  if (result.status === "linked_elsewhere") {
    const message = `This ${result.externalProvider} account is already linked to another PageDen account.`;
    if (options.html) return reply.code(409).type("text/html").send(`<h1>Already linked</h1><p>${escapeHtml(message)}</p>`);
    return reply.code(409).send({ error: "already_linked", message });
  }
  if (options.html) return reply.type("text/html").send("<h1>Integration connected</h1><p>You can return to the external app.</p>");
  return reply.send({ link: linkDto(result.link) });
}

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { workspaceId: string }; Body: unknown }>("/api/workspaces/:workspaceId/integrations", async (request, reply) => {
    const userId = await requireWorkspaceAdmin(request, reply, request.params.workspaceId);
    if (!userId) return;
    const parsed = parseIntegrationBody(request.body);
    if ("fields" in parsed) return validationError(reply, parsed.fields);

    const clientId = createSecret(CLIENT_ID_PREFIX);
    const clientSecret = createSecret(SECRET_PREFIX);
    const integration = await prisma.workspaceIntegration.create({
      data: {
        workspaceId: request.params.workspaceId,
        providerKey: parsed.providerKey,
        runtimeMode: parsed.runtimeMode,
        name: parsed.name,
        clientId,
        clientSecretHash: sha256(clientSecret),
        scopes: parsed.scopes,
        createdById: userId,
      },
    });
    return reply.code(201).send({ integration: integrationDto(integration), clientSecret });
  });

  app.get<{ Params: { workspaceId: string } }>("/api/workspaces/:workspaceId/integrations", async (request, reply) => {
    const userId = await requireWorkspaceAdmin(request, reply, request.params.workspaceId);
    if (!userId) return;
    const integrations = await prisma.workspaceIntegration.findMany({
      where: { workspaceId: request.params.workspaceId },
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    });
    return { integrations: integrations.map(integrationDto) };
  });

  app.post<{ Params: { workspaceId: string; id: string } }>("/api/workspaces/:workspaceId/integrations/:id/rotate-secret", async (request, reply) => {
    const userId = await requireWorkspaceAdmin(request, reply, request.params.workspaceId);
    if (!userId) return;
    const clientSecret = createSecret(SECRET_PREFIX);
    const updated = await prisma.workspaceIntegration.updateMany({
      where: { id: request.params.id, workspaceId: request.params.workspaceId, revokedAt: null },
      data: { clientSecretHash: sha256(clientSecret) },
    });
    if (updated.count === 0) return reply.code(404).send({ error: "not_found", message: "Integration not found." });
    const integration = await prisma.workspaceIntegration.findUniqueOrThrow({ where: { id: request.params.id } });
    return { integration: integrationDto(integration), clientSecret };
  });

  app.delete<{ Params: { workspaceId: string; id: string } }>("/api/workspaces/:workspaceId/integrations/:id", async (request, reply) => {
    const userId = await requireWorkspaceAdmin(request, reply, request.params.workspaceId);
    if (!userId) return;
    const existing = await prisma.workspaceIntegration.findFirst({ where: { id: request.params.id, workspaceId: request.params.workspaceId } });
    if (!existing) return reply.code(404).send({ error: "not_found", message: "Integration not found." });
    const integration = await prisma.workspaceIntegration.update({
      where: { id: existing.id },
      data: { revokedAt: existing.revokedAt ?? new Date() },
    });
    return { integration: integrationDto(integration) };
  });

  app.post<{ Body: unknown }>("/api/integrations/connect-sessions", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "connect:write");
    if (!integration) return;
    const parsed = parseExternalIdentity(request.body);
    if ("fields" in parsed) return validationError(reply, parsed.fields);

    const rawToken = createSecret(CONNECT_TOKEN_PREFIX);
    const session = await prisma.externalConnectSession.create({
      data: {
        workspaceId: integration.workspaceId,
        integrationId: integration.id,
        tokenHash: sha256(rawToken),
        externalProvider: parsed.externalProvider,
        externalAccountId: parsed.externalAccountId,
        externalUsername: parsed.externalUsername,
        externalMetadata: parsed.externalMetadata ?? undefined,
        expiresAt: new Date(Date.now() + CONNECT_TTL_MS),
      },
      select: { id: true, expiresAt: true },
    });

    return reply.code(201).send({
      sessionId: session.id,
      connectUrl: `${env.appUrl}/integrations/connect?token=${encodeURIComponent(rawToken)}`,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.get<{ Querystring: { token?: string } }>("/integrations/connect", async (request, reply) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    const session = token
      ? await prisma.externalConnectSession.findUnique({
          where: { tokenHash: sha256(token) },
          select: {
            id: true,
            workspaceId: true,
            externalProvider: true,
            externalAccountId: true,
            externalUsername: true,
            expiresAt: true,
            usedAt: true,
            workspace: { select: { name: true } },
            integration: { select: { name: true } },
          },
        })
      : null;
    if (!session || session.usedAt || session.expiresAt <= new Date()) {
      return reply.code(404).type("text/html").send("<h1>Connect link expired</h1>");
    }

    const auth = await requireAuth(request);
    const membership = await prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: session.workspaceId, userId: auth.userId } },
      select: { user: { select: { email: true } } },
    });
    if (!membership) return reply.code(403).type("text/html").send("<h1>Workspace membership required</h1>");

    reply.header("Referrer-Policy", "no-referrer");
    return reply.type("text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Connect PageDen</title></head>
<body>
  <h1>Connect PageDen</h1>
  <p>Link PageDen account ${escapeHtml(membership.user.email)} to ${escapeHtml(session.externalProvider)} user ${escapeHtml(session.externalUsername ?? session.externalAccountId)} for ${escapeHtml(session.integration.name)} in ${escapeHtml(session.workspace.name)}?</p>
  <form method="get" action="/api/integrations/connect-sessions/${encodeURIComponent(session.id)}/confirm">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit">Connect</button>
  </form>
</body></html>`);
  });

  app.post<{ Params: { id: string }; Body: { token?: string }; Querystring: { token?: string } }>(
    "/api/integrations/connect-sessions/:id/confirm",
    async (request, reply) => {
      const auth = await requireAuth(request);
      const rawToken = request.body?.token ?? request.query.token ?? "";
      if (!rawToken) return validationError(reply, { token: "Connect token is required." });
      return sendConfirmResult(reply, await confirmConnectSession({ sessionId: request.params.id, rawToken, userId: auth.userId }));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>("/api/integrations/connect-sessions/:id/confirm", async (request, reply) => {
    const auth = await requireAuth(request);
    const rawToken = request.query.token ?? "";
    if (!rawToken) return reply.code(400).type("text/html").send("<h1>Missing connect token</h1>");
    return sendConfirmResult(reply, await confirmConnectSession({ sessionId: request.params.id, rawToken, userId: auth.userId }), { html: true });
  });

  app.get<{ Querystring: { externalProvider?: string; externalAccountId?: string } }>("/api/integrations/link-status", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "links:read");
    if (!integration) return;
    const parsed = parseExternalIdentity(request.query);
    if ("fields" in parsed) return validationError(reply, parsed.fields);
    const link = await prisma.externalAccountLink.findUnique({
      where: {
        integrationId_externalProvider_externalAccountId: {
          integrationId: integration.id,
          externalProvider: parsed.externalProvider,
          externalAccountId: parsed.externalAccountId,
        },
      },
      select: {
        id: true,
        workspaceId: true,
        integrationId: true,
        userId: true,
        externalProvider: true,
        externalAccountId: true,
        externalUsername: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!link || link.revokedAt) return { linked: false, link: null };
    const updated = await prisma.externalAccountLink.update({
      where: { id: link.id },
      data: { lastUsedAt: new Date() },
      select: {
        id: true,
        workspaceId: true,
        integrationId: true,
        externalProvider: true,
        externalAccountId: true,
        externalUsername: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { linked: true, link: linkDto(updated) };
  });

  app.get("/api/me/external-links", async (request) => {
    const auth = await requireAuth(request);
    const links = await prisma.externalAccountLink.findMany({
      where: { userId: auth.userId },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
        integration: { select: { id: true, providerKey: true, runtimeMode: true, name: true } },
      },
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    });
    return { links: links.map(linkDto) };
  });

  app.delete<{ Params: { id: string } }>("/api/me/external-links/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    const link = await prisma.externalAccountLink.findFirst({ where: { id: request.params.id, userId: auth.userId } });
    if (!link) return reply.code(404).send({ error: "not_found", message: "External account link not found." });
    const updated = await prisma.externalAccountLink.update({
      where: { id: link.id },
      data: { revokedAt: link.revokedAt ?? new Date() },
    });
    return { link: linkDto(updated) };
  });

  // ---------------------------------------------------------------------------
  // REST actions (Phase 2) — called by external integrations (e.g. Hermes bot)
  // ---------------------------------------------------------------------------

  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      documentId?: string;
      path?: string;
    };
  }>("/api/integrations/actions/document-read", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:read");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? "").trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    const documentId = request.body.documentId?.trim() || null;
    const path = request.body.path?.trim() || null;

    if (!externalProvider || !externalAccountId) {
      return reply.code(400).send({ error: "bad_request", message: "externalProvider and externalAccountId are required." });
    }
    if (!documentId && !path) {
      return reply.code(400).send({ error: "bad_request", message: "documentId or path is required." });
    }

    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const doc = await prisma.document.findFirst({
      where: documentId
        ? { id: documentId, workspaceId: integration.workspaceId, deletedAt: null }
        : { path: path!, workspaceId: integration.workspaceId, deletedAt: null },
    });
    if (!doc) return reply.code(404).send({ error: "not_found", message: "Document not found." });

    const role = await resolveDocumentRole(link.userId, doc.id);
    if (!atLeast(role, "viewer")) return reply.code(403).send({ error: "forbidden", message: "You do not have access to this document." });

    let content = "";
    if (doc.currentVersionId) {
      const revision = await prisma.documentRevision.findUnique({
        where: { id: doc.currentVersionId },
        select: { storageKey: true },
      });
      if (revision) content = await readContent(revision.storageKey);
    }

    const attachments = await prisma.attachment.findMany({
      where: { documentId: doc.id, deletedAt: null },
      select: { id: true, filename: true, contentType: true, size: true },
      orderBy: { createdAt: "asc" },
    });

    await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });

    return {
      document: {
        id: doc.id,
        title: doc.title,
        path: doc.path,
        status: doc.status,
        version: doc.currentVersionId,
        updatedAt: doc.updatedAt.toISOString(),
        content,
        attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
      },
    };
  });

  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      query?: string;
      limit?: number;
      canonicalOnly?: boolean;
    };
  }>("/api/integrations/actions/document-search", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:read");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? "").trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    const query = (request.body.query ?? "").trim();

    if (!externalProvider || !externalAccountId) {
      return reply.code(400).send({ error: "bad_request", message: "externalProvider and externalAccountId are required." });
    }
    if (!query) return validationError(reply, { query: "query is required." });

    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const limit = clampSearchLimit(request.body.limit, 10);
    const results = await searchDocuments({
      userId: link.userId,
      workspaceId: integration.workspaceId,
      query,
      limit,
      canonicalOnly: request.body.canonicalOnly ?? false,
    });

    await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });

    return { results };
  });

  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      path?: string;
      title?: string;
      content?: string;
    };
  }>("/api/integrations/actions/document-create", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:write");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? integration.providerKey).trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    if (!externalAccountId) {
      return reply.code(400).send({ error: "bad_request", message: "externalAccountId is required to create documents." });
    }
    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const rawPath = (request.body.path ?? "").trim();
    const title = (request.body.title ?? "").trim();
    if (!rawPath) return reply.code(400).send({ error: "bad_request", message: "path is required." });
    if (!title) return reply.code(400).send({ error: "bad_request", message: "title is required." });

    const parsed = parsePath(rawPath);
    if (!parsed) {
      return reply.code(400).send({
        error: "bad_request",
        message: "Invalid path. Use lowercase letters, numbers, and hyphens (e.g. /handbook/notes/my-note).",
      });
    }
    const { folderPath, slug } = parsed;

    const folder = await prisma.folder.findFirst({
      where: { path: folderPath, workspaceId: integration.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!folder) return reply.code(404).send({ error: "not_found", message: `Folder not found at path: ${folderPath || "(root)"}` });

    const folderRole = await resolveFolderRole(link.userId, folder.id);
    if (!atLeast(folderRole, "editor")) {
      return reply.code(403).send({ error: "forbidden", message: "You need editor access to create documents in this folder." });
    }

    const content = request.body.content ?? "";
    const sum = computeChecksum(content);
    const { storageKey } = await writeContent(content, integration.workspaceId);

    try {
      const doc = await prisma.$transaction(async (tx) => {
        await lockFolderTree(tx, integration.workspaceId);
        const lockedFolder = await tx.folder.findFirst({
          where: { id: folder.id, workspaceId: integration.workspaceId, deletedAt: null },
          select: { path: true },
        });
        if (!lockedFolder) throw Object.assign(new Error("folder_missing"), { code: "folder_missing" });
        const docPath = buildDocumentPath(lockedFolder.path, slug);
        const taken = await tx.document.findFirst({ where: { folderId: folder.id, slug, deletedAt: null } });
        if (taken) throw Object.assign(new Error("collision"), { code: "collision" });

        const created = await tx.document.create({
          data: {
            workspaceId: integration.workspaceId,
            folderId: folder.id,
            title,
            slug,
            path: docPath,
            createdById: link.userId,
            updatedById: link.userId,
          },
        });
        const revision = await tx.documentRevision.create({
          data: {
            documentId: created.id,
            versionNumber: 1,
            storageKey,
            checksum: sum,
            createdById: link.userId,
            changeSource: "agent",
            contributorIds: [link.userId],
          },
        });
        const meta = await metadataFromContent(tx, integration.workspaceId, content, created.id);
        return tx.document.update({
          where: { id: created.id },
          data: {
            currentVersionId: revision.id,
            currentChecksum: sum,
            searchText: searchTextFor(content),
            status: meta.status,
            supersededById: meta.supersededById,
            updatedById: link.userId,
          },
        });
      });
      await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });
      return { document: { id: doc.id, title: doc.title, path: doc.path, status: doc.status, version: doc.currentVersionId } };
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === "collision") return reply.code(409).send({ error: "conflict", message: `A document with slug '${slug}' already exists in that folder.` });
      if (code === "folder_missing") return reply.code(404).send({ error: "not_found", message: "Folder was deleted concurrently." });
      throw error;
    }
  });

  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      documentId?: string;
      path?: string;
      content?: string;
    };
  }>("/api/integrations/actions/document-append", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:write");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? integration.providerKey).trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    if (!externalAccountId) return reply.code(400).send({ error: "bad_request", message: "externalAccountId is required." });
    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const documentId = request.body.documentId?.trim() || null;
    const docPath = request.body.path?.trim() || null;
    const appendContent = (request.body.content ?? "").trim();
    if (!documentId && !docPath) return reply.code(400).send({ error: "bad_request", message: "documentId or path is required." });
    if (!appendContent) return reply.code(400).send({ error: "bad_request", message: "content is required." });

    const doc = await prisma.document.findFirst({
      where: documentId
        ? { id: documentId, workspaceId: integration.workspaceId, deletedAt: null }
        : { path: docPath!, workspaceId: integration.workspaceId, deletedAt: null },
      select: { id: true, currentVersionId: true },
    });
    if (!doc) return reply.code(404).send({ error: "not_found", message: "Document not found." });

    let existingContent = "";
    if (doc.currentVersionId) {
      const revision = await prisma.documentRevision.findUnique({ where: { id: doc.currentVersionId }, select: { storageKey: true } });
      if (revision) existingContent = await readContent(revision.storageKey);
    }

    const newContent = existingContent ? `${existingContent}\n\n${appendContent}` : appendContent;
    const outcome = await applyDocumentWrite({
      documentId: doc.id,
      auth: { userId: link.userId, authType: "token" },
      baseVersion: doc.currentVersionId ?? "",
      content: newContent,
      changeSource: "agent",
    });

    if (!outcome.ok) {
      if (outcome.status === "conflict") return reply.code(409).send({ error: "conflict", message: "Document was modified concurrently. Retry with the latest version." });
      if (outcome.status === "not_found") return reply.code(404).send({ error: "not_found", message: "Document not found." });
      if (outcome.status === "forbidden") return reply.code(403).send({ error: "forbidden", message: "You do not have editor access to this document." });
      if (outcome.status === "not_canonical") return reply.code(409).send({ error: "not_canonical", message: "Document must be in canonical status to edit." });
      return reply.code(500).send({ error: "internal", message: "Write failed." });
    }

    await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });
    return { document: { id: doc.id, version: outcome.version } };
  });

  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      documentId?: string;
      path?: string;
      content?: string;
      title?: string;
    };
  }>("/api/integrations/actions/document-update", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:write");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? integration.providerKey).trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    if (!externalAccountId) return reply.code(400).send({ error: "bad_request", message: "externalAccountId is required." });
    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const documentId = request.body.documentId?.trim() || null;
    const docPath = request.body.path?.trim() || null;
    const content = request.body.content;
    const title = request.body.title?.trim();
    if (!documentId && !docPath) return reply.code(400).send({ error: "bad_request", message: "documentId or path is required." });
    if (content === undefined && !title) return reply.code(400).send({ error: "bad_request", message: "content or title is required." });

    const doc = await prisma.document.findFirst({
      where: documentId
        ? { id: documentId, workspaceId: integration.workspaceId, deletedAt: null }
        : { path: docPath!, workspaceId: integration.workspaceId, deletedAt: null },
      select: { id: true, currentVersionId: true },
    });
    if (!doc) return reply.code(404).send({ error: "not_found", message: "Document not found." });

    let resolvedContent = content;
    if (resolvedContent === undefined) {
      if (doc.currentVersionId) {
        const revision = await prisma.documentRevision.findUnique({ where: { id: doc.currentVersionId }, select: { storageKey: true } });
        if (revision) resolvedContent = await readContent(revision.storageKey);
      }
      resolvedContent = resolvedContent ?? "";
    }

    const outcome = await applyDocumentWrite({
      documentId: doc.id,
      auth: { userId: link.userId, authType: "token" },
      baseVersion: doc.currentVersionId ?? "",
      content: resolvedContent,
      title,
      changeSource: "agent",
    });

    if (!outcome.ok) {
      if (outcome.status === "conflict") return reply.code(409).send({ error: "conflict", message: "Document was modified concurrently. Retry with the latest version." });
      if (outcome.status === "not_found") return reply.code(404).send({ error: "not_found", message: "Document not found." });
      if (outcome.status === "forbidden") return reply.code(403).send({ error: "forbidden", message: "You do not have editor access to this document." });
      if (outcome.status === "not_canonical") return reply.code(409).send({ error: "not_canonical", message: "Document must be in canonical status to edit." });
      return reply.code(500).send({ error: "internal", message: "Write failed." });
    }

    await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });
    return { document: { id: doc.id, version: outcome.version } };
  });

  const fileAttachBodyLimit = Math.ceil(MAX_ATTACHMENT_BYTES * (4 / 3)) + 65536;

  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      documentId?: string;
      path?: string;
      fileContent?: string;
      filename?: string;
    };
  }>("/api/integrations/actions/file-attach", { bodyLimit: fileAttachBodyLimit }, async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:write");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? integration.providerKey).trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    if (!externalAccountId) return reply.code(400).send({ error: "bad_request", message: "externalAccountId is required." });
    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const documentId = request.body.documentId?.trim() || null;
    const docPath = request.body.path?.trim() || null;
    const fileContent = request.body.fileContent?.trim() || null;
    if (!documentId && !docPath) return reply.code(400).send({ error: "bad_request", message: "documentId or path is required." });
    if (!fileContent) return reply.code(400).send({ error: "bad_request", message: "fileContent is required." });

    const doc = await prisma.document.findFirst({
      where: documentId
        ? { id: documentId, workspaceId: integration.workspaceId, deletedAt: null }
        : { path: docPath!, workspaceId: integration.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!doc) return reply.code(404).send({ error: "not_found", message: "Document not found." });

    let fileBuffer: Buffer;
    try {
      fileBuffer = Buffer.from(fileContent, "base64");
    /* v8 ignore next 2 */
    } catch {
      return reply.code(400).send({ error: "bad_request", message: "fileContent is not valid base64." });
    }
    const detectedFilename = request.body.filename?.trim() || "attachment";
    const ext = detectedFilename.split(".").pop()?.toLowerCase() || "";
    const mime: Record<string, string> = {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      mp4: "video/mp4",
      txt: "text/plain",
      md: "text/markdown",
      csv: "text/csv",
      json: "application/json",
      zip: "application/zip",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      doc: "application/msword",
      xls: "application/vnd.ms-excel",
      ppt: "application/vnd.ms-powerpoint",
    };
    const contentType = mime[ext] ?? "application/octet-stream";

    try {
      const { attachment } = await createDocumentAttachment({
        documentId: doc.id,
        userId: link.userId,
        filename: detectedFilename,
        contentType,
        body: fileBuffer,
      });
      await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });
      return { attachment };
    /* v8 ignore next 4 */
    } catch (error: unknown) {
      const status = (error as { status?: number }).status ?? 500;
      const message = (error as { message?: string }).message ?? "Attachment failed.";
      return reply.code(status).send({ error: "attachment_error", message });
    }
  });

  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      attachmentId?: string;
    };
  }>("/api/integrations/actions/list-workspaces", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:read");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? integration.providerKey).trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    if (!externalAccountId) return reply.code(400).send({ error: "bad_request", message: "externalAccountId is required." });

    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const memberships = await prisma.workspaceMembership.findMany({
      where: { userId: link.userId },
      select: { workspaceId: true, role: true, workspace: { select: { id: true, name: true, slug: true } } },
      orderBy: { workspace: { name: "asc" } },
    });

    await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });
    return { workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug, role: m.role })) };
  });

  app.post<{
    Body: { externalProvider?: string; externalAccountId?: string; attachmentId?: string };
  }>("/api/integrations/actions/attachment-read", async (request, reply) => {
    const integration = await requireIntegrationAuth(request, reply, "documents:read");
    if (!integration) return;

    const externalProvider = (request.body.externalProvider ?? integration.providerKey).trim();
    const externalAccountId = (request.body.externalAccountId ?? "").trim();
    const attachmentId = (request.body.attachmentId ?? "").trim();

    if (!attachmentId) return reply.code(400).send({ error: "bad_request", message: "attachmentId is required." });
    if (!externalAccountId) return reply.code(400).send({ error: "bad_request", message: "externalAccountId is required." });

    const link = await resolveLink(integration, externalProvider, externalAccountId, reply);
    if (!link) return;

    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, deletedAt: null },
    });
    if (!attachment) return reply.code(404).send({ error: "not_found", message: "Attachment not found." });

    if (attachment.workspaceId !== integration.workspaceId) {
      return reply.code(404).send({ error: "not_found", message: "Attachment not found." });
    }

    const role = await resolveDocumentRole(link.userId, attachment.documentId);
    if (!atLeast(role, "viewer")) return reply.code(404).send({ error: "not_found", message: "Attachment not found." });

    if (attachment.status === "SCANNING") {
      return reply.code(503).send({ error: "scan_pending", message: "Attachment is being scanned, try again shortly." });
    }
    if (attachment.status === "QUARANTINED") {
      return reply.code(403).send({ error: "forbidden", message: "Attachment is not available." });
    }

    const bytes = await readBlob(attachment.storageKey);
    await prisma.externalAccountLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });

    return {
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        sha256: attachment.sha256,
        contentBase64: bytes.toString("base64"),
      },
    };
  });
}

async function resolveLink(
  integration: IntegrationAuth,
  externalProvider: string,
  externalAccountId: string,
  reply: FastifyReply,
): Promise<{ id: string; userId: string } | null> {
  const link = await prisma.externalAccountLink.findUnique({
    where: {
      integrationId_externalProvider_externalAccountId: {
        integrationId: integration.id,
        externalProvider,
        externalAccountId,
      },
    },
    select: { id: true, userId: true, revokedAt: true },
  });

  if (!link || link.revokedAt) {
    const rawToken = createSecret(CONNECT_TOKEN_PREFIX);
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + CONNECT_TTL_MS);
    await prisma.externalConnectSession.create({
      data: {
        workspaceId: integration.workspaceId,
        integrationId: integration.id,
        tokenHash,
        externalProvider,
        externalAccountId,
        expiresAt,
      },
    });
    const connectUrl = `${env.appUrl}/integrations/connect?token=${encodeURIComponent(rawToken)}`;
    reply.code(403).send({
      error: "account_not_linked",
      message: "This external account is not linked to a PageDen account. Ask the user to connect their account first.",
      connectUrl,
    });
    return null;
  }

  return { id: link.id, userId: link.userId };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
