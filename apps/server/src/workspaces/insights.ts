import type { FastifyInstance } from "fastify";
import { DocumentStatus, type Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { notFound, validationError } from "../errors.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import { listActiveClaims } from "../documents/claims.js";
import { openCommentCountByDocument } from "../documents/comments.js";
import { documentContext } from "../ai-readiness.js";
import { readContent } from "../storage.js";

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
  "document_marked_canonical",
  "document_marked_superseded",
  "document_marked_draft",
  "document_marked_archived",
  "document_created_by_agent",
  "document_updated_by_agent",
  "document_appended_by_agent",
  "comment_added",
  "comment_added_by_agent",
  "comment_resolved",
  "comment_resolved_by_agent",
  "comment_deleted",
]);

const ACTIVE_PLANNING_STATUSES = new Set(["drafting", "review", "revision", "final-review", "deferred"]);
const ACTIVE_PLANNING_SCAN_LIMIT = 200;
const ACTIVE_PLANNING_RESULT_LIMIT = 20;

type ActorKind = "user" | "agent" | "system" | "obsidian_plugin" | "unknown";
type ActivityEventDto = {
  id: string;
  workspaceId: string | null;
  userId: string | null;
  actor: ActorKind;
  action: string;
  targetType: string;
  targetId: string | null;
  documentTitle: string | null;
  documentPath: string | null;
  createdAt: string;
  metadata: unknown;
};

const COALESCED_AGENT_ACTIONS = new Set(["document_updated_by_agent", "comment_added_by_agent", "comment_resolved_by_agent"]);
const AGENT_STATUS_ACTIONS = new Set([
  "document_marked_canonical_by_agent",
  "document_marked_superseded_by_agent",
  "document_marked_draft_by_agent",
  "document_marked_archived_by_agent",
]);

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

function frontmatterString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

function frontmatterNumber(value: string | string[] | undefined): number | null {
  const raw = frontmatterString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function coalesceKey(event: ActivityEventDto): string | null {
  if (event.actor !== "agent" || !COALESCED_AGENT_ACTIONS.has(event.action)) return null;
  const metadata = metadataObject(event.metadata);
  const tokenId = typeof metadata.tokenId === "string" ? metadata.tokenId : event.userId ?? "";
  return [event.action, event.targetId ?? "", tokenId].join(":");
}

function coalesceActivity(events: ActivityEventDto[]): ActivityEventDto[] {
  const result: ActivityEventDto[] = [];
  for (const event of events) {
    const key = coalesceKey(event);
    const previous = result[result.length - 1];
    if (key && previous && coalesceKey(previous) === key) {
      const previousMetadata = metadataObject(previous.metadata);
      const eventMetadata = metadataObject(event.metadata);
      const count = Number(previousMetadata.count ?? 1) + 1;
      const eventIds = Array.isArray(previousMetadata.eventIds) ? previousMetadata.eventIds : [previous.id];
      const versions = Array.isArray(previousMetadata.versions)
        ? previousMetadata.versions
        : typeof previousMetadata.version === "string"
          ? [previousMetadata.version]
          : [];
      if (typeof eventMetadata.version === "string") versions.push(eventMetadata.version);
      previous.metadata = {
        ...previousMetadata,
        count,
        eventIds: [...eventIds, event.id],
        ...(versions.length > 0 ? { versions: [...new Set(versions)] } : {}),
      };
      continue;
    }
    result.push(event);
  }
  return result.filter((event, index) => !isRedundantStatusUpdate(event, result[index + 1] ?? null));
}

function activityTokenId(event: ActivityEventDto): string | null {
  const metadata = metadataObject(event.metadata);
  return typeof metadata.tokenId === "string" ? metadata.tokenId : null;
}

function isRedundantStatusUpdate(event: ActivityEventDto, next: ActivityEventDto | null): boolean {
  if (event.action !== "document_updated_by_agent" || !next || !AGENT_STATUS_ACTIONS.has(next.action)) return false;
  if (event.targetId !== next.targetId) return false;
  if (activityTokenId(event) !== activityTokenId(next)) return false;
  return Math.abs(new Date(event.createdAt).getTime() - new Date(next.createdAt).getTime()) <= 10_000;
}

function activityDtoFor(
  event: {
    id: string;
    workspaceId: string | null;
    userId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    createdAt: Date;
    metadata: unknown;
  },
  doc: { id: string; title: string; path: string } | null,
): ActivityEventDto {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    userId: event.userId,
    actor: actorFor(event.action, event.metadata, event.userId),
    action: event.action,
    targetType: event.targetType,
    targetId: doc?.id ?? event.targetId,
    documentTitle: doc?.title ?? null,
    documentPath: doc?.path ?? null,
    createdAt: event.createdAt.toISOString(),
    metadata: event.metadata ?? null,
  };
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
        const docId = documentIdForEvent(event);
        if (docId) documentIds.add(docId);
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
        events: coalesceActivity(
          events
            .map((event) => {
              const docId = documentIdForEvent(event);
              const doc = docId ? docById.get(docId) ?? null : null;
              if (doc && resolver.documentRole({ id: doc.id, folderId: doc.folderId }) === null) return null;
              return activityDtoFor(event, doc);
            })
            .filter((event): event is NonNullable<typeof event> => event !== null),
        ).slice(0, limit),
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
        select: { id: true, folderId: true, title: true, path: true, status: true, updatedAt: true, supersededById: true, currentVersionId: true },
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
        take: 75,
      });
      const recentDocIds = new Set<string>();
      for (const event of recentEvents) {
        const docId = documentIdForEvent(event);
        if (docId) recentDocIds.add(docId);
      }
      const recentDocs = recentDocIds.size
        ? await prisma.document.findMany({
            where: { id: { in: [...recentDocIds] }, workspaceId, deletedAt: null },
            select: { id: true, title: true, path: true, folderId: true },
          })
        : [];
      const recentById = new Map(recentDocs.map((doc) => [doc.id, doc]));

      const recentActivity = coalesceActivity(
        recentEvents
          .map((event) => {
            const docId = documentIdForEvent(event);
            const doc = docId ? recentById.get(docId) ?? null : null;
            if (doc && resolver.documentRole({ id: doc.id, folderId: doc.folderId }) === null) return null;
            return activityDtoFor(event, doc);
          })
          .filter((event): event is NonNullable<typeof event> => event !== null),
      ).slice(0, 15);

      // Filter claims down to documents the caller can see; this prevents
      // surfacing a doc title through a claim row that the user has no
      // role on.
      const visibleDocIds = new Set(visibleDocs.map((d) => d.id));
      const allClaims = await listActiveClaims(workspaceId);
      const activeClaims = allClaims.filter((claim) => visibleDocIds.has(claim.documentId));

      const openCommentCounts = await openCommentCountByDocument(visibleDocs.map((d) => d.id));
      const openComments = [...openCommentCounts.entries()].reduce((sum, [, count]) => sum + count, 0);
      const activeClaimByDocument = new Map(activeClaims.map((claim) => [claim.documentId, claim]));

      const activePlanningCandidates = [...visibleDocs]
        .filter((doc) => doc.status !== "archived" && doc.currentVersionId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, ACTIVE_PLANNING_SCAN_LIMIT);
      const revisionIds = activePlanningCandidates.map((doc) => doc.currentVersionId!).filter(Boolean);
      const revisions = revisionIds.length
        ? await prisma.documentRevision.findMany({
            where: { id: { in: revisionIds } },
            select: { id: true, storageKey: true },
          })
        : [];
      const storageKeyByRevisionId = new Map(revisions.map((revision) => [revision.id, revision.storageKey]));
      const activePlanning = [];
      for (const doc of activePlanningCandidates) {
        const storageKey = doc.currentVersionId ? storageKeyByRevisionId.get(doc.currentVersionId) : null;
        if (!storageKey) continue;
        const context = documentContext(await readContent(storageKey));
        if (frontmatterString(context.frontmatter.workflow) !== "multi-agent-planning") continue;
        const workflowStatus = frontmatterString(context.frontmatter.workflowStatus);
        if (!workflowStatus || !ACTIVE_PLANNING_STATUSES.has(workflowStatus)) continue;
        const claim = activeClaimByDocument.get(doc.id) ?? null;
        activePlanning.push({
          id: doc.id,
          title: doc.title,
          path: doc.path,
          status: doc.status,
          updatedAt: doc.updatedAt.toISOString(),
          workflowStatus,
          reviewRound: frontmatterNumber(context.frontmatter.reviewRound),
          leadAgent: frontmatterString(context.frontmatter.leadAgent),
          reviewAgent: frontmatterString(context.frontmatter.reviewAgent),
          openCommentCount: openCommentCounts.get(doc.id) ?? 0,
          activeClaim: claim
            ? {
                id: claim.id,
                actorLabel: claim.actorLabel,
                note: claim.note,
                expiresAt: claim.expiresAt,
              }
            : null,
        });
        if (activePlanning.length >= ACTIVE_PLANNING_RESULT_LIMIT) break;
      }

      return {
        workspaceId,
        totals: { folders: resolver.folders.length, documents: visibleDocs.length, openComments },
        statusCounts,
        supersededDocs,
        recentChanges,
        recentActivity,
        activePlanning,
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
    const docId = documentIdForEvent(event);
    if (docId) documentIds.add(docId);
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
    events: coalesceActivity(
      events
        .map((event) => {
          const docId = documentIdForEvent(event);
          const doc = docId ? docById.get(docId) ?? null : null;
          if (doc && resolver.documentRole({ id: doc.id, folderId: doc.folderId }) === null) return null;
          return activityDtoFor(event, doc);
        })
        .filter((event): event is NonNullable<typeof event> => event !== null),
    ).slice(0, opts.limit),
    nextBefore: next ? next.createdAt.toISOString() : null,
  };
}

function documentIdForEvent(event: { targetType: string; targetId: string | null; metadata: unknown }): string | null {
  if (event.targetType === "document" && event.targetId) return event.targetId;
  if (event.metadata && typeof event.metadata === "object" && "documentId" in event.metadata) {
    const documentId = (event.metadata as { documentId?: unknown }).documentId;
    return typeof documentId === "string" && documentId ? documentId : null;
  }
  return null;
}
