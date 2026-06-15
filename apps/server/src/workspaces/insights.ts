import type { FastifyInstance } from "fastify";
import { DocumentStatus, type Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { notFound, validationError } from "../errors.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import { listActiveClaims } from "../documents/claims.js";
import { openCommentCountByDocument } from "../documents/comments.js";

// Activity timeline + workspace dashboard. Both are derived from data we already
// store (AuditEvent + Document + Folder), so we can ship them without a schema
// change — and so a follow-up that adds real ownership/PR tracking can layer on.

const DOCUMENT_ACTIONS = new Set([
  "document_created",
  "document_updated",
  "document_pushed",
  "document_renamed",
  "document_moved",
  "document_deleted",
  "document_restored",
  "document_created_by_agent",
  "document_updated_by_agent",
  "document_appended_by_agent",
  "mcp_tool_called",
]);

type ActorKind = "user" | "agent" | "system" | "obsidian_plugin" | "unknown";

function actorFor(action: string, metadata: unknown, userId: string | null): ActorKind {
  if (action.endsWith("_by_agent") || action === "mcp_tool_called") return "agent";
  if (action === "document_pushed") return "obsidian_plugin";
  if (
    metadata &&
    typeof metadata === "object" &&
    "tokenKind" in metadata &&
    typeof (metadata as { tokenKind?: unknown }).tokenKind === "string"
  ) {
    const kind = (metadata as { tokenKind: string }).tokenKind;
    if (kind === "agent") return "agent";
    if (kind === "obsidian") return "obsidian_plugin";
  }
  if (userId) return "user";
  return "system";
}

async function assertWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { workspaceId: true },
  });
  return membership !== null;
}

export async function registerWorkspaceInsightsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { workspaceId: string }; Querystring: { limit?: string; before?: string } }>(
    "/api/workspaces/:workspaceId/activity",
    { config: { rateLimit: { max: Number(process.env.WORKSPACE_INSIGHTS_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const workspaceId = request.params.workspaceId;
      if (!(await assertWorkspaceMember(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");

      const rawLimit = Number(request.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 50;
      const before = request.query.before ? new Date(request.query.before) : null;
      if (before && Number.isNaN(before.getTime())) {
        return validationError(reply, { before: "before must be an ISO timestamp." });
      }

      const events = await prisma.auditEvent.findMany({
        where: {
          workspaceId,
          action: { in: [...DOCUMENT_ACTIONS] },
          ...(before ? { createdAt: { lt: before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
      });
      const next = events.length > limit ? events.pop() ?? null : null;

      const documentIds = new Set<string>();
      for (const event of events) {
        if (event.targetType === "document" && event.targetId) documentIds.add(event.targetId);
      }
      const documents = documentIds.size
        ? await prisma.document.findMany({
            where: { id: { in: [...documentIds] }, workspaceId, deletedAt: null },
            select: { id: true, title: true, path: true, folderId: true },
          })
        : [];
      const docById = new Map(documents.map((doc) => [doc.id, doc]));
      const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);

      return {
        workspaceId,
        events: events
          .map((event) => {
            const doc = event.targetType === "document" && event.targetId ? docById.get(event.targetId) ?? null : null;
            if (doc && resolver.documentRole({ id: doc.id, folderId: doc.folderId }) === null) return null;
            return {
              id: event.id,
              workspaceId: event.workspaceId,
              userId: event.userId,
              actor: actorFor(event.action, event.metadata, event.userId),
              action: event.action,
              targetType: event.targetType,
              targetId: event.targetId,
              documentTitle: doc?.title ?? null,
              documentPath: doc?.path ?? null,
              createdAt: event.createdAt.toISOString(),
              metadata: event.metadata ?? null,
            };
          })
          .filter((event): event is NonNullable<typeof event> => event !== null),
        nextBefore: next ? next.createdAt.toISOString() : null,
      };
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/dashboard",
    { config: { rateLimit: { max: Number(process.env.WORKSPACE_INSIGHTS_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const workspaceId = request.params.workspaceId;
      if (!(await assertWorkspaceMember(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");

      const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
      const docs = await prisma.document.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, folderId: true, title: true, path: true, status: true, updatedAt: true, supersededById: true },
      });
      const visibleDocs = docs.filter((doc) => resolver.documentRole({ id: doc.id, folderId: doc.folderId }) !== null);
      const statusCounts: Record<DocumentStatus, number> = { canonical: 0, draft: 0, superseded: 0, archived: 0 };
      for (const doc of visibleDocs) statusCounts[doc.status] += 1;

      const supersededIds = new Set(visibleDocs.filter((d) => d.status === "superseded").map((d) => d.id));
      const supersededTargets = visibleDocs.filter((d) => d.status === "superseded" && d.supersededById);
      const targetIds = new Set(supersededTargets.map((d) => d.supersededById!).filter(Boolean));
      const targetMap = targetIds.size
        ? new Map(
            (
              await prisma.document.findMany({
                where: { id: { in: [...targetIds] }, deletedAt: null },
                select: { id: true, title: true, path: true },
              })
            ).map((doc) => [doc.id, doc]),
          )
        : new Map();
      const supersededDocs = visibleDocs
        .filter((doc) => supersededIds.has(doc.id))
        .slice(0, 20)
        .map((doc) => ({
          id: doc.id,
          title: doc.title,
          path: doc.path,
          supersededBy: doc.supersededById ? targetMap.get(doc.supersededById) ?? null : null,
        }));

      const recentChanges = [...visibleDocs]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, 10)
        .map((doc) => ({
          id: doc.id,
          title: doc.title,
          path: doc.path,
          status: doc.status,
          updatedAt: doc.updatedAt.toISOString(),
        }));

      const folderCounts = new Map<string, number>();
      for (const doc of visibleDocs) folderCounts.set(doc.folderId, (folderCounts.get(doc.folderId) ?? 0) + 1);
      const topFolders = resolver.folders
        .filter((folder) => resolver.folderRole(folder.id) !== null)
        .map((folder) => ({
          id: folder.id,
          path: folder.path,
          name: folder.name,
          documentCount: folderCounts.get(folder.id) ?? 0,
        }))
        .sort((a, b) => b.documentCount - a.documentCount || a.path.localeCompare(b.path))
        .slice(0, 10);

      const recentEvents = await prisma.auditEvent.findMany({
        where: { workspaceId, action: { in: [...DOCUMENT_ACTIONS] } },
        orderBy: { createdAt: "desc" },
        take: 25,
      });
      const recentDocIds = new Set<string>();
      for (const event of recentEvents) {
        if (event.targetType === "document" && event.targetId) recentDocIds.add(event.targetId);
      }
      const recentDocs = recentDocIds.size
        ? await prisma.document.findMany({
            where: { id: { in: [...recentDocIds] }, workspaceId, deletedAt: null },
            select: { id: true, title: true, path: true, folderId: true },
          })
        : [];
      const recentById = new Map(recentDocs.map((doc) => [doc.id, doc]));

      const recentActivity = recentEvents
        .map((event) => {
          const doc = event.targetType === "document" && event.targetId ? recentById.get(event.targetId) ?? null : null;
          if (doc && resolver.documentRole({ id: doc.id, folderId: doc.folderId }) === null) return null;
          return {
            id: event.id,
            workspaceId: event.workspaceId,
            userId: event.userId,
            actor: actorFor(event.action, event.metadata, event.userId),
            action: event.action,
            targetType: event.targetType,
            targetId: event.targetId,
            documentTitle: doc?.title ?? null,
            documentPath: doc?.path ?? null,
            createdAt: event.createdAt.toISOString(),
            metadata: event.metadata ?? null,
          };
        })
        .filter((event): event is NonNullable<typeof event> => event !== null)
        .slice(0, 15);

      // Filter claims down to documents the caller can see; this prevents
      // surfacing a doc title through a claim row that the user has no
      // role on.
      const visibleDocIds = new Set(visibleDocs.map((d) => d.id));
      const allClaims = await listActiveClaims(workspaceId);
      const activeClaims = allClaims.filter((claim) => visibleDocIds.has(claim.documentId));

      const openCommentCounts = await openCommentCountByDocument(visibleDocs.map((d) => d.id));
      const openComments = [...openCommentCounts.entries()].reduce((sum, [, count]) => sum + count, 0);

      return {
        workspaceId,
        totals: { folders: resolver.folders.length, documents: visibleDocs.length, openComments },
        statusCounts,
        supersededDocs,
        recentChanges,
        recentActivity,
        topFolders,
        activeClaims,
      };
    },
  );
}

// Exported for the MCP layer so the activity-timeline tool can reuse the same logic.
export async function workspaceActivityFor(
  userId: string,
  workspaceId: string,
  opts: { limit: number; before?: Date | null },
): Promise<Awaited<ReturnType<typeof workspaceActivityImpl>>> {
  return workspaceActivityImpl(userId, workspaceId, opts);
}

async function workspaceActivityImpl(
  userId: string,
  workspaceId: string,
  opts: { limit: number; before?: Date | null },
) {
  const where: Prisma.AuditEventWhereInput = {
    workspaceId,
    action: { in: [...DOCUMENT_ACTIONS] },
    ...(opts.before ? { createdAt: { lt: opts.before } } : {}),
  };
  const events = await prisma.auditEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
  });
  const next = events.length > opts.limit ? events.pop() ?? null : null;

  const documentIds = new Set<string>();
  for (const event of events) {
    if (event.targetType === "document" && event.targetId) documentIds.add(event.targetId);
  }
  const documents = documentIds.size
    ? await prisma.document.findMany({
        where: { id: { in: [...documentIds] }, workspaceId, deletedAt: null },
        select: { id: true, title: true, path: true, folderId: true },
      })
    : [];
  const docById = new Map(documents.map((doc) => [doc.id, doc]));
  const resolver = await buildWorkspaceResolver(userId, workspaceId);

  return {
    workspaceId,
    events: events
      .map((event) => {
        const doc = event.targetType === "document" && event.targetId ? docById.get(event.targetId) ?? null : null;
        if (doc && resolver.documentRole({ id: doc.id, folderId: doc.folderId }) === null) return null;
        return {
          id: event.id,
          workspaceId: event.workspaceId,
          userId: event.userId,
          actor: actorFor(event.action, event.metadata, event.userId),
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          documentTitle: doc?.title ?? null,
          documentPath: doc?.path ?? null,
          createdAt: event.createdAt.toISOString(),
          metadata: event.metadata ?? null,
        };
      })
      .filter((event): event is NonNullable<typeof event> => event !== null),
    nextBefore: next ? next.createdAt.toISOString() : null,
  };
}
