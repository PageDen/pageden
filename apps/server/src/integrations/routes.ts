import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma.js";
import { requireAuth } from "../auth.js";
import { requireIntegrationAuth, requireIntegrationScope } from "./auth.js";
import { canManageWorkspace, resolveDocumentRole, atLeast } from "../permissions/index.js";
import { searchDocuments, clampSearchLimit } from "../search/service.js";
import { readContent } from "../storage.js";
import { hashToken, createRawToken } from "../tokens.js";
import { env } from "../env.js";
import { forbidden, isUniqueViolation, notFound, validationError } from "../errors.js";
import { writeAuditEvent } from "../audit.js";

const CLIENT_ID_PREFIX = "pd_int_";
const CLIENT_SECRET_PREFIX = "pd_sec_";
const CONNECT_SESSION_TTL_MS = 15 * 60 * 1000;

function createClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(16).toString("base64url")}`;
}

function createClientSecret(): string {
  return `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function integrationDto(i: {
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
    id: i.id,
    workspaceId: i.workspaceId,
    providerKey: i.providerKey,
    runtimeMode: i.runtimeMode,
    name: i.name,
    clientId: i.clientId,
    scopes: i.scopes,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    lastUsedAt: i.lastUsedAt?.toISOString() ?? null,
    revokedAt: i.revokedAt?.toISOString() ?? null,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function renderConnectPage({
  integrationName,
  workspaceName,
  externalProvider,
  externalUsername,
  confirmUrl,
}: {
  integrationName: string;
  workspaceName: string;
  externalProvider: string;
  externalUsername: string | null;
  confirmUrl: string;
}) {
  const escapedIntegration = escapeHtml(integrationName);
  const escapedWorkspace = escapeHtml(workspaceName);
  const escapedProvider = escapeHtml(externalProvider);
  const escapedUsername = externalUsername ? escapeHtml(externalUsername) : null;
  const identity = escapedUsername ? `<strong>${escapedUsername}</strong> on ${escapedProvider}` : `your ${escapedProvider} account`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect ${escapedIntegration} - Pageden</title>
  <style>
    body{margin:0;background:#f8fafc;color:#0f172a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{min-height:100vh;display:grid;place-items:center;padding:24px}
    section{width:min(520px,100%);background:#fff;border:1px solid #dbe3ef;border-radius:16px;box-shadow:0 20px 60px rgba(15,23,42,.08);padding:28px}
    .brand{display:flex;align-items:center;gap:12px;font-weight:700}.logo{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#f45107;color:#fff}
    h1{font-size:28px;margin:28px 0 8px}p{color:#64748b;line-height:1.55}
    .info{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;color:#334155;margin:16px 0}
    form{margin-top:22px}button{display:flex;align-items:center;justify-content:center;width:100%;height:48px;border-radius:10px;background:#f45107;color:#fff;border:none;cursor:pointer;font-size:16px;font-weight:700}
    small{display:block;margin-top:14px;color:#94a3b8;text-align:center}
  </style>
</head>
<body>
  <main>
    <section>
      <div class="brand"><span class="logo">P</span><span>Pageden</span></div>
      <h1>Connect ${escapedIntegration}</h1>
      <p>This will link ${identity} to your PageDen account in the <strong>${escapedWorkspace}</strong> workspace.</p>
      <div class="info">
        <strong>${escapedIntegration}</strong> will be able to request PageDen actions on your behalf.<br/>
        PageDen will always enforce your workspace and document permissions.
      </div>
      <form method="POST" action="${escapeHtml(confirmUrl)}">
        <button type="submit">Connect account</button>
      </form>
      <small>You can disconnect this at any time from your PageDen account settings.</small>
    </section>
  </main>
</body>
</html>`;
}

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // Admin: create integration
  // ---------------------------------------------------------------------------
  app.post<{
    Params: { workspaceId: string };
    Body: { providerKey?: string; runtimeMode?: string; name?: string; scopes?: string[] };
  }>("/api/workspaces/:workspaceId/integrations", async (request, reply) => {
    const auth = await requireAuth(request);
    const { workspaceId } = request.params;

    if (!(await canManageWorkspace(auth.userId, workspaceId))) return forbidden(reply);

    const providerKey = request.body.providerKey?.trim() ?? "";
    const runtimeMode = request.body.runtimeMode?.trim() ?? "rest";
    const name = request.body.name?.trim() ?? "";
    const scopes = Array.isArray(request.body.scopes) ? request.body.scopes : [];

    const fields: Record<string, string> = {};
    if (!providerKey) fields.providerKey = "Provider key is required.";
    if (!name) fields.name = "Name is required.";
    if (Object.keys(fields).length > 0) return validationError(reply, fields);

    const clientId = createClientId();
    const rawSecret = createClientSecret();
    const clientSecretHash = hashToken(rawSecret, env.tokenHashSecret);

    const integration = await prisma.workspaceIntegration.create({
      data: {
        workspaceId,
        providerKey,
        runtimeMode,
        name,
        clientId,
        clientSecretHash,
        scopes,
        createdById: auth.userId,
      },
    });

    await writeAuditEvent({
      userId: auth.userId,
      workspaceId,
      action: "integration_created",
      targetType: "workspace_integration",
      targetId: integration.id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      metadata: { name, providerKey, runtimeMode, scopes },
    });

    return reply.code(201).send({
      integration: integrationDto(integration),
      clientSecret: rawSecret,
    });
  });

  // ---------------------------------------------------------------------------
  // Admin: list integrations
  // ---------------------------------------------------------------------------
  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/integrations",
    async (request, reply) => {
      const auth = await requireAuth(request);
      const { workspaceId } = request.params;

      if (!(await canManageWorkspace(auth.userId, workspaceId))) return forbidden(reply);

      const integrations = await prisma.workspaceIntegration.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
      });

      return { integrations: integrations.map(integrationDto) };
    },
  );

  // ---------------------------------------------------------------------------
  // Admin: rotate secret
  // ---------------------------------------------------------------------------
  app.post<{ Params: { workspaceId: string; id: string } }>(
    "/api/workspaces/:workspaceId/integrations/:id/rotate-secret",
    async (request, reply) => {
      const auth = await requireAuth(request);
      const { workspaceId, id } = request.params;

      if (!(await canManageWorkspace(auth.userId, workspaceId))) return forbidden(reply);

      const integration = await prisma.workspaceIntegration.findFirst({
        where: { id, workspaceId, revokedAt: null },
      });
      if (!integration) return notFound(reply, "Integration not found.");

      const rawSecret = createClientSecret();
      const clientSecretHash = hashToken(rawSecret, env.tokenHashSecret);

      const updated = await prisma.workspaceIntegration.update({
        where: { id },
        data: { clientSecretHash },
      });

      await writeAuditEvent({
        userId: auth.userId,
        workspaceId,
        action: "integration_secret_rotated",
        targetType: "workspace_integration",
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      return { integration: integrationDto(updated), clientSecret: rawSecret };
    },
  );

  // ---------------------------------------------------------------------------
  // Admin: revoke integration
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { workspaceId: string; id: string } }>(
    "/api/workspaces/:workspaceId/integrations/:id",
    async (request, reply) => {
      const auth = await requireAuth(request);
      const { workspaceId, id } = request.params;

      if (!(await canManageWorkspace(auth.userId, workspaceId))) return forbidden(reply);

      const integration = await prisma.workspaceIntegration.findFirst({
        where: { id, workspaceId },
      });
      if (!integration) return notFound(reply, "Integration not found.");

      if (!integration.revokedAt) {
        await prisma.workspaceIntegration.update({
          where: { id },
          data: { revokedAt: new Date() },
        });
        await writeAuditEvent({
          userId: auth.userId,
          workspaceId,
          action: "integration_revoked",
          targetType: "workspace_integration",
          targetId: id,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        });
      }

      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // Integration: create connect session
  // ---------------------------------------------------------------------------
  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      externalUsername?: string;
      externalMetadata?: Record<string, unknown>;
    };
  }>("/api/integrations/connect-sessions", async (request, reply) => {
    const { integration } = await requireIntegrationAuth(request);
    requireIntegrationScope(integration, "connect:write");

    const externalProvider = request.body.externalProvider?.trim() ?? "";
    const externalAccountId = request.body.externalAccountId?.trim() ?? "";
    const externalUsername = request.body.externalUsername?.trim() || null;
    const externalMetadata = request.body.externalMetadata ?? null;

    const fields: Record<string, string> = {};
    if (!externalProvider) fields.externalProvider = "externalProvider is required.";
    if (!externalAccountId) fields.externalAccountId = "externalAccountId is required.";
    if (Object.keys(fields).length > 0) return validationError(reply, fields);

    const rawToken = createRawToken();
    const tokenHash = hashToken(rawToken, env.tokenHashSecret);
    const expiresAt = new Date(Date.now() + CONNECT_SESSION_TTL_MS);

    const session = await prisma.externalConnectSession.create({
      data: {
        workspaceId: integration.workspaceId,
        integrationId: integration.id,
        tokenHash,
        externalProvider,
        externalAccountId,
        externalUsername,
        externalMetadata: externalMetadata as never,
        expiresAt,
      },
    });

    const connectUrl = `${env.webOrigin}/integrations/connect?token=${encodeURIComponent(rawToken)}`;

    return reply.code(201).send({
      sessionId: session.id,
      connectUrl,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // Browser: show connect confirmation page
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { token?: string } }>("/integrations/connect", async (request, reply) => {
    const rawToken = request.query.token ?? "";
    if (!rawToken) return reply.code(400).send({ error: "bad_request", message: "Missing token." });

    const tokenHash = hashToken(rawToken, env.tokenHashSecret);
    const session = await prisma.externalConnectSession.findUnique({
      where: { tokenHash },
      include: {
        integration: { select: { name: true, revokedAt: true } },
        workspace: { select: { name: true } },
      },
    });

    if (!session || session.usedAt || session.expiresAt <= new Date() || session.integration.revokedAt) {
      reply.type("text/html; charset=utf-8");
      return `<!doctype html><html><head><meta charset="utf-8"><title>Link expired - Pageden</title></head><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>This link has expired or already been used.</h2><p>Ask your integration to generate a new one.</p></body></html>`;
    }

    const confirmUrl = `${env.webOrigin}/api/integrations/connect-sessions/${session.id}/confirm?token=${encodeURIComponent(rawToken)}`;
    reply.type("text/html; charset=utf-8");
    reply.header("Referrer-Policy", "no-referrer");
    return renderConnectPage({
      integrationName: session.integration.name,
      workspaceName: session.workspace.name,
      externalProvider: session.externalProvider,
      externalUsername: session.externalUsername,
      confirmUrl,
    });
  });

  // ---------------------------------------------------------------------------
  // Browser: confirm link (session auth required)
  // ---------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Querystring: { token?: string };
  }>("/api/integrations/connect-sessions/:id/confirm", async (request, reply) => {
    const auth = await requireAuth(request);
    const rawToken = request.query.token ?? "";
    if (!rawToken) return reply.code(400).send({ error: "bad_request", message: "Missing token." });

    const tokenHash = hashToken(rawToken, env.tokenHashSecret);
    const session = await prisma.externalConnectSession.findUnique({
      where: { tokenHash },
      include: { integration: { select: { workspaceId: true, revokedAt: true } } },
    });

    if (
      !session ||
      session.id !== request.params.id ||
      session.usedAt ||
      session.expiresAt <= new Date() ||
      session.integration.revokedAt
    ) {
      return reply.code(410).send({ error: "session_expired", message: "This connect link has expired or already been used." });
    }

    // User must be a member of the integration's workspace
    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: session.workspaceId, userId: auth.userId },
      },
      select: { role: true },
    });
    if (!membership) return forbidden(reply, "You are not a member of this workspace.");

    const now = new Date();

    // Check for an existing active link for a DIFFERENT user — that's a conflict
    const existing = await prisma.externalAccountLink.findUnique({
      where: {
        integrationId_externalProvider_externalAccountId: {
          integrationId: session.integrationId,
          externalProvider: session.externalProvider,
          externalAccountId: session.externalAccountId,
        },
      },
    });

    let link: { id: string };

    if (existing) {
      if (existing.userId !== auth.userId && !existing.revokedAt) {
        return reply.code(409).send({ error: "account_conflict", message: "This external account is already linked to a different PageDen user in this integration." });
      }
      // Same user reconnecting, or previous link was revoked — refresh it
      link = await prisma.externalAccountLink.update({
        where: { id: existing.id },
        data: {
          userId: auth.userId,
          workspaceId: session.workspaceId,
          externalUsername: session.externalUsername,
          externalMetadata: session.externalMetadata ?? undefined,
          revokedAt: null,
          updatedAt: now,
        },
        select: { id: true },
      });
    } else {
      try {
        link = await prisma.externalAccountLink.create({
          data: {
            workspaceId: session.workspaceId,
            integrationId: session.integrationId,
            userId: auth.userId,
            externalProvider: session.externalProvider,
            externalAccountId: session.externalAccountId,
            externalUsername: session.externalUsername,
            externalMetadata: session.externalMetadata ?? undefined,
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "account_conflict", message: "This external account is already linked to a different PageDen user in this integration." });
        }
        throw error;
      }
    }

    await prisma.externalConnectSession.update({ where: { id: session.id }, data: { usedAt: now } });

    await writeAuditEvent({
      userId: auth.userId,
      workspaceId: session.workspaceId,
      action: "external_account_linked",
      targetType: "external_account_link",
      targetId: link.id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      metadata: {
        integrationId: session.integrationId,
        externalProvider: session.externalProvider,
        externalAccountId: session.externalAccountId,
      },
    });

    reply.type("text/html; charset=utf-8");
    reply.header("Referrer-Policy", "no-referrer");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connected - Pageden</title>
  <style>
    body{margin:0;background:#f8fafc;color:#0f172a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{min-height:100vh;display:grid;place-items:center;padding:24px}
    section{width:min(520px,100%);background:#fff;border:1px solid #dbe3ef;border-radius:16px;box-shadow:0 20px 60px rgba(15,23,42,.08);padding:28px;text-align:center}
    .logo{display:inline-grid;place-items:center;width:48px;height:48px;border-radius:12px;background:#f45107;color:#fff;font-weight:700;font-size:20px;margin-bottom:20px}
    h1{font-size:28px;margin:0 0 12px}p{color:#64748b;line-height:1.55}
    .check{font-size:40px;margin-bottom:8px}
  </style>
</head>
<body>
  <main>
    <section>
      <div class="logo">P</div>
      <div class="check">✓</div>
      <h1>Account connected</h1>
      <p>Your PageDen account is now linked. You can close this tab and return to the chat.</p>
    </section>
  </main>
</body>
</html>`;
  });

  // ---------------------------------------------------------------------------
  // Integration: link status
  // ---------------------------------------------------------------------------
  app.get<{
    Querystring: { externalProvider?: string; externalAccountId?: string };
  }>("/api/integrations/link-status", async (request, reply) => {
    const { integration } = await requireIntegrationAuth(request);
    requireIntegrationScope(integration, "links:read");

    const externalProvider = request.query.externalProvider?.trim() ?? "";
    const externalAccountId = request.query.externalAccountId?.trim() ?? "";
    if (!externalProvider || !externalAccountId) {
      return reply.code(400).send({ error: "bad_request", message: "externalProvider and externalAccountId are required." });
    }

    const link = await prisma.externalAccountLink.findUnique({
      where: {
        integrationId_externalProvider_externalAccountId: {
          integrationId: integration.id,
          externalProvider,
          externalAccountId,
        },
      },
      select: { id: true, userId: true, externalUsername: true, createdAt: true, revokedAt: true },
    });

    if (!link || link.revokedAt) {
      return { linked: false };
    }

    return {
      linked: true,
      linkId: link.id,
      externalUsername: link.externalUsername,
      linkedAt: link.createdAt.toISOString(),
    };
  });

  // ---------------------------------------------------------------------------
  // User: list external links
  // ---------------------------------------------------------------------------
  app.get("/api/me/external-links", async (request) => {
    const auth = await requireAuth(request);
    const links = await prisma.externalAccountLink.findMany({
      where: { userId: auth.userId, revokedAt: null },
      include: {
        integration: { select: { id: true, name: true, providerKey: true, workspaceId: true } },
        workspace: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      links: links.map((l) => ({
        id: l.id,
        externalProvider: l.externalProvider,
        externalAccountId: l.externalAccountId,
        externalUsername: l.externalUsername,
        linkedAt: l.createdAt.toISOString(),
        lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
        integration: l.integration,
        workspace: l.workspace,
      })),
    };
  });

  // ---------------------------------------------------------------------------
  // User: revoke external link
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>("/api/me/external-links/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    const link = await prisma.externalAccountLink.findFirst({
      where: { id: request.params.id, userId: auth.userId },
    });
    if (!link) return notFound(reply, "Link not found.");

    if (!link.revokedAt) {
      await prisma.externalAccountLink.update({
        where: { id: link.id },
        data: { revokedAt: new Date() },
      });
      await writeAuditEvent({
        userId: auth.userId,
        workspaceId: link.workspaceId,
        action: "external_account_revoked",
        targetType: "external_account_link",
        targetId: link.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    }

    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // REST action: document-read
  // ---------------------------------------------------------------------------
  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      documentId?: string;
      path?: string;
    };
  }>("/api/integrations/actions/document-read", async (request, reply) => {
    const { integration } = await requireIntegrationAuth(request);
    requireIntegrationScope(integration, "documents:read");

    const externalProvider = request.body.externalProvider?.trim() ?? "";
    const externalAccountId = request.body.externalAccountId?.trim() ?? "";
    const documentId = request.body.documentId?.trim() || null;
    const path = request.body.path?.trim() || null;

    if (!externalProvider || !externalAccountId) {
      return reply.code(400).send({ error: "bad_request", message: "externalProvider and externalAccountId are required." });
    }
    if (!documentId && !path) {
      return reply.code(400).send({ error: "bad_request", message: "documentId or path is required." });
    }

    const link = await resolveLink(integration.id, externalProvider, externalAccountId, integration.workspaceId, reply);
    if (!link) return;

    const doc = await prisma.document.findFirst({
      where: documentId
        ? { id: documentId, workspaceId: integration.workspaceId, deletedAt: null }
        : { path: path!, workspaceId: integration.workspaceId, deletedAt: null },
    });
    if (!doc) return notFound(reply, "Document not found.");

    const role = await resolveDocumentRole(link.userId, doc.id);
    if (!atLeast(role, "viewer")) return forbidden(reply, "You do not have access to this document.");

    let content = "";
    if (doc.currentVersionId) {
      const revision = await prisma.documentRevision.findUnique({
        where: { id: doc.currentVersionId },
        select: { storageKey: true },
      });
      if (revision) content = await readContent(revision.storageKey);
    }

    await prisma.externalAccountLink.update({
      where: { id: link.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      document: {
        id: doc.id,
        title: doc.title,
        path: doc.path,
        status: doc.status,
        version: doc.currentVersionId,
        updatedAt: doc.updatedAt.toISOString(),
        content,
      },
    };
  });

  // ---------------------------------------------------------------------------
  // REST action: document-search
  // ---------------------------------------------------------------------------
  app.post<{
    Body: {
      externalProvider?: string;
      externalAccountId?: string;
      query?: string;
      limit?: number;
      canonicalOnly?: boolean;
    };
  }>("/api/integrations/actions/document-search", async (request, reply) => {
    const { integration } = await requireIntegrationAuth(request);
    requireIntegrationScope(integration, "documents:read");

    const externalProvider = request.body.externalProvider?.trim() ?? "";
    const externalAccountId = request.body.externalAccountId?.trim() ?? "";
    const query = request.body.query?.trim() ?? "";

    if (!externalProvider || !externalAccountId) {
      return reply.code(400).send({ error: "bad_request", message: "externalProvider and externalAccountId are required." });
    }
    if (!query) return validationError(reply, { query: "query is required." });

    const link = await resolveLink(integration.id, externalProvider, externalAccountId, integration.workspaceId, reply);
    if (!link) return;

    const limit = clampSearchLimit(request.body.limit, 10);
    const results = await searchDocuments({
      userId: link.userId,
      workspaceId: integration.workspaceId,
      query,
      limit,
      canonicalOnly: request.body.canonicalOnly ?? false,
    });

    await prisma.externalAccountLink.update({
      where: { id: link.id },
      data: { lastUsedAt: new Date() },
    });

    return { results };
  });
}

async function resolveLink(
  integrationId: string,
  externalProvider: string,
  externalAccountId: string,
  workspaceId: string,
  reply: import("fastify").FastifyReply,
): Promise<{ id: string; userId: string } | null> {
  const link = await prisma.externalAccountLink.findUnique({
    where: {
      integrationId_externalProvider_externalAccountId: {
        integrationId,
        externalProvider,
        externalAccountId,
      },
    },
    select: { id: true, userId: true, revokedAt: true },
  });

  if (!link || link.revokedAt) {
    // Generate a fresh connect session so the caller can send the user a link
    const rawToken = createRawToken();
    const tokenHash = hashToken(rawToken, env.tokenHashSecret);
    const expiresAt = new Date(Date.now() + CONNECT_SESSION_TTL_MS);
    await prisma.externalConnectSession.create({
      data: {
        workspaceId,
        integrationId,
        tokenHash,
        externalProvider,
        externalAccountId,
        expiresAt,
      },
    });
    const connectUrl = `${env.webOrigin}/integrations/connect?token=${encodeURIComponent(rawToken)}`;
    reply.code(403).send({
      error: "account_not_linked",
      message: "This external account is not linked to a PageDen account. Ask the user to connect their account first.",
      connectUrl,
    });
    return null;
  }

  return { id: link.id, userId: link.userId };
}
