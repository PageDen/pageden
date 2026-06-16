import type { FastifyInstance } from "fastify";
import { Prisma, DocumentStatus } from "@prisma/client";
import type { ChangeSource } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { canonicalize, checksum as computeChecksum } from "../checksum.js";
import { aiReadinessForDocument, documentContext } from "../ai-readiness.js";
import { implementationReadinessFor, taskPacketFor, type TaskPacket } from "./handoff.js";

// searchText denormalizes current content for FTS. Cap the indexed text so a pathological
// document cannot bloat the row or exceed Postgres's tsvector size limit (~1MB of lexemes).
const SEARCH_TEXT_MAX = 200_000;
const REVISION_BURST_WINDOW_MS = Number(process.env.REVISION_BURST_WINDOW_MS ?? 5 * 60 * 1000);
export function searchTextFor(content: string): string {
  // Strip the private-use highlight markers so they can only ever come from ts_headline, never
  // from document content (prevents a control/data collision in snippets).
  // eslint-disable-next-line no-control-regex -- intentionally stripping NUL (0x00)
  const canonical = canonicalize(content).replace(/[\uE000\uE001\u0000]/g, "");
  return canonical.length > SEARCH_TEXT_MAX ? canonical.slice(0, SEARCH_TEXT_MAX) : canonical;
}

import { readContent, writeContent } from "../storage.js";
import { buildDownloadMarkdown, contentDisposition, downloadFilename } from "./download.js";
import { buildDocumentPath, isValidSlug } from "../paths.js";
import { conflict, forbidden, isUniqueViolation, notFound, validationError } from "../errors.js";
import { atLeast, authorizeDocumentRole, authorizeFolderRole, canManageWorkspace, capabilitiesFor, resolveDocumentRole, resolveFolderRole } from "../permissions/index.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import { lockFolderTree } from "../db.js";
import { clampSearchLimit, searchDocuments, SEARCH_QUERY_MAX } from "../search/service.js";

type Tx = Prisma.TransactionClient;

const DOCUMENT_STATUS_VALUES: DocumentStatus[] = ["canonical", "draft", "superseded", "archived"];

function parseDocumentStatus(value: unknown): DocumentStatus | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (DOCUMENT_STATUS_VALUES as string[]).includes(lower) ? (lower as DocumentStatus) : null;
}

function normalizeDocumentPath(value: string): { base: string; withMd: string } {
  const base = value.trim().replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase().replace(/\.md$/i, "");
  return { base, withMd: `${base}.md` };
}

// Derive the canonical/superseded metadata from a document's Markdown frontmatter so a single
// write (web edit, plugin push, agent update) keeps status and the supersededBy link in sync
// with the document body. Unknown statuses fall back to `canonical`; an unresolvable path
// frontmatter clears the link rather than failing the write.
export async function metadataFromContent(
  tx: Tx,
  workspaceId: string,
  content: string,
  exceptDocumentId?: string,
): Promise<{ status: DocumentStatus; supersededById: string | null }> {
  const ctx = documentContext(content);
  const status = parseDocumentStatus(ctx.frontmatter.status) ?? "canonical";
  const raw = ctx.frontmatter.supersededBy;
  const path = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!path || path.length > 1024) return { status, supersededById: null };
  const { base, withMd } = normalizeDocumentPath(path);
  if (!base) return { status, supersededById: null };
  const target = await tx.document.findFirst({
    where: { workspaceId, deletedAt: null, path: { in: [base, withMd] } },
    select: { id: true },
  });
  const supersededById = target?.id && target.id !== exceptDocumentId ? target.id : null;
  return { status, supersededById };
}

type RevisionListRow = {
  id: string;
  versionNumber: number;
  checksum: string;
  createdById: string;
  createdAt: Date;
  changeSource: ChangeSource;
  message: string | null;
  revisionGroupId: string | null;
  contributorIds: string[];
  isPinned: boolean;
  label: string | null;
};

async function siblingSlugTaken(tx: Tx, folderId: string, slug: string, exceptId?: string): Promise<boolean> {
  const existing = await tx.document.findFirst({
    where: { folderId, slug, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return existing !== null;
}

async function revisionGroupIdForWrite(tx: Tx, doc: { id: string }, opts: { userId: string; changeSource: ChangeSource }): Promise<string | null> {
  if (opts.changeSource === "import" || opts.changeSource === "system" || REVISION_BURST_WINDOW_MS <= 0) return null;

  const previous = await tx.documentRevision.findFirst({
    where: { documentId: doc.id },
    orderBy: { versionNumber: "desc" },
    select: {
      id: true,
      versionNumber: true,
      createdById: true,
      createdAt: true,
      changeSource: true,
      message: true,
      revisionGroupId: true,
      isPinned: true,
      label: true,
    },
  });
  if (!previous || previous.versionNumber <= 1 || previous.message || previous.isPinned || previous.label) return null;
  if (previous.createdById !== opts.userId || previous.changeSource !== opts.changeSource) return null;
  if (Date.now() - previous.createdAt.getTime() > REVISION_BURST_WINDOW_MS) return null;
  return previous.revisionGroupId ?? previous.id;
}

function revisionListItem(revision: RevisionListRow) {
  return {
    id: revision.id,
    versionNumber: revision.versionNumber,
    checksum: revision.checksum,
    createdBy: revision.createdById,
    createdAt: revision.createdAt.toISOString(),
    changeSource: revision.changeSource,
    message: revision.message,
    contributorIds: revision.contributorIds,
    isPinned: revision.isPinned,
    label: revision.label,
  };
}

function groupedRevisionList(revisions: RevisionListRow[]) {
  const groups = new Map<string, RevisionListRow[]>();
  for (const revision of revisions) {
    const key = revision.revisionGroupId ?? revision.id;
    const group = groups.get(key);
    if (group) group.push(revision);
    else groups.set(key, [revision]);
  }

  return Array.from(groups.values()).map((group) => {
    const sorted = [...group].sort((a, b) => b.versionNumber - a.versionNumber);
    const head = sorted[0]!;
    const versionNumbers = sorted.map((revision) => revision.versionNumber);
    return {
      ...revisionListItem(head),
      groupId: head.revisionGroupId ?? head.id,
      groupCount: sorted.length,
      groupStartVersionNumber: Math.min(...versionNumbers),
      groupEndVersionNumber: Math.max(...versionNumbers),
      collapsedRevisions: sorted.slice(1).map(revisionListItem),
    };
  });
}

function historyActorFor(action: string, metadata: unknown, userId: string | null): "user" | "agent" | "system" | "obsidian_plugin" | "unknown" {
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

const HISTORY_EVENT_ACTIONS = [
  "document_created",
  "document_updated",
  "document_pushed",
  "document_renamed",
  "document_moved",
  "document_restored",
  "document_created_by_agent",
  "document_updated_by_agent",
  "document_appended_by_agent",
  "document_revision_metadata_updated",
] as const;

interface WriteOutcome {
  ok: boolean;
  status?: "not_found" | "forbidden" | "conflict";
  currentVersion?: string;
  documentId?: string;
  version?: string;
  checksum?: string;
  updatedAt?: Date;
}

// Shared write path for PUT (web) and push (plugin): row-locked transaction, baseVersion
// check, version allocation, content storage — stale write returns conflict, never a 500.
export async function applyDocumentWrite(opts: {
  documentId: string;
  auth: AuthContext;
  baseVersion: string;
  content: string;
  title?: string;
  changeSource: ChangeSource;
}): Promise<WriteOutcome> {
  const userId = opts.auth.userId;
  // Cheap preflight (re-checked authoritatively under the lock below) so a forbidden or stale
  // write does not perform storage work. Avoids a storage/CPU abuse vector.
  const pre = await prisma.document.findFirst({
    where: { id: opts.documentId, deletedAt: null },
    select: { currentVersionId: true, currentChecksum: true, title: true, workspaceId: true, folderId: true },
  });
  if (!pre) return { ok: false, status: "not_found" };
  const preAz = await authorizeDocumentRole(opts.auth, opts.documentId, "editor");
  if (!preAz.ok) return preAz;
  if ((pre.currentVersionId ?? "") !== opts.baseVersion) {
    return { ok: false, status: "conflict", currentVersion: pre.currentVersionId ?? "" };
  }

  const sum = computeChecksum(opts.content);
  const preContentUnchanged = pre.currentChecksum !== null && pre.currentChecksum === sum;
  // Content is written before the transaction only when the preflight proves it may be needed, so
  // the row lock is held only for DB work. Orphan objects are harmless: storage is
  // content-addressed and idempotent (review H4).
  const storageKey = preContentUnchanged ? null : (await writeContent(opts.content, pre.workspaceId)).storageKey;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Document" WHERE "id" = ${opts.documentId} AND "deletedAt" IS NULL FOR UPDATE`;
    if (locked.length === 0) return { ok: false, status: "not_found" };

    const az = await authorizeDocumentRole(opts.auth, opts.documentId, "editor", tx);
    if (!az.ok) return az;

    const doc = await tx.document.findUniqueOrThrow({ where: { id: opts.documentId } });
    if ((doc.currentVersionId ?? "") !== opts.baseVersion) {
      return { ok: false, status: "conflict", currentVersion: doc.currentVersionId ?? "" };
    }

    const titleChanged = opts.title !== undefined && opts.title !== doc.title;
    if (doc.currentChecksum !== null && doc.currentChecksum === sum) {
      if (!titleChanged) {
        return {
          ok: true,
          documentId: doc.id,
          version: doc.currentVersionId ?? "",
          checksum: doc.currentChecksum,
          updatedAt: doc.updatedAt,
        };
      }

      const updated = await tx.document.update({
        where: { id: doc.id },
        data: { title: opts.title, updatedById: userId },
      });
      await writeAuditEvent(
        {
          workspaceId: doc.workspaceId,
          userId,
          action: opts.changeSource === "obsidian_plugin" ? "document_pushed" : "document_updated",
          targetType: "document",
          targetId: doc.id,
          metadata: { version: doc.currentVersionId, titleOnly: true },
        },
        tx,
      );
      return {
        ok: true,
        documentId: doc.id,
        version: doc.currentVersionId ?? "",
        checksum: doc.currentChecksum,
        updatedAt: updated.updatedAt,
      };
    }

    const revisionStorageKey = storageKey ?? (await writeContent(opts.content, doc.workspaceId)).storageKey;
    const max = await tx.documentRevision.aggregate({
      where: { documentId: doc.id },
      _max: { versionNumber: true },
    });
    const revisionGroupId = await revisionGroupIdForWrite(tx, doc, { userId, changeSource: opts.changeSource });
    const revision = await tx.documentRevision.create({
      data: {
        documentId: doc.id,
        versionNumber: (max._max.versionNumber ?? 0) + 1,
        storageKey: revisionStorageKey,
        checksum: sum,
        createdById: userId,
        changeSource: opts.changeSource,
        revisionGroupId,
        contributorIds: [userId],
      },
    });
    const metadata = await metadataFromContent(tx, doc.workspaceId, opts.content, doc.id);
    const updated = await tx.document.update({
      where: { id: doc.id },
      data: {
        currentVersionId: revision.id,
        currentChecksum: sum,
        searchText: searchTextFor(opts.content),
        updatedById: userId,
        title: opts.title ?? doc.title,
        status: metadata.status,
        supersededById: metadata.supersededById,
      },
    });
    await writeAuditEvent(
      {
        workspaceId: doc.workspaceId,
        userId,
        action: opts.changeSource === "obsidian_plugin" ? "document_pushed" : "document_updated",
        targetType: "document",
        targetId: doc.id,
        metadata: { version: revision.id },
      },
      tx,
    );
    await writeStatusTransitionAudit(tx, {
      workspaceId: doc.workspaceId,
      userId,
      documentId: doc.id,
      previousStatus: doc.status,
      nextStatus: metadata.status,
      previousSupersededById: doc.supersededById,
      nextSupersededById: metadata.supersededById,
    });
    return { ok: true, documentId: doc.id, version: revision.id, checksum: sum, updatedAt: updated.updatedAt };
  });
}

async function writeStatusTransitionAudit(
  tx: Prisma.TransactionClient,
  opts: {
    workspaceId: string;
    userId: string;
    documentId: string;
    previousStatus: DocumentStatus;
    nextStatus: DocumentStatus;
    previousSupersededById: string | null;
    nextSupersededById: string | null;
  },
): Promise<void> {
  if (opts.previousStatus === opts.nextStatus && opts.previousSupersededById === opts.nextSupersededById) return;
  const action =
    opts.nextStatus === "canonical"
      ? "document_marked_canonical"
      : opts.nextStatus === "superseded"
        ? "document_marked_superseded"
        : opts.nextStatus === "archived"
          ? "document_marked_archived"
          : "document_marked_draft";
  await writeAuditEvent(
    {
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      action,
      targetType: "document",
      targetId: opts.documentId,
      metadata: {
        previousStatus: opts.previousStatus,
        nextStatus: opts.nextStatus,
        previousSupersededById: opts.previousSupersededById,
        nextSupersededById: opts.nextSupersededById,
      },
    },
    tx,
  );
}

// Per-workspace single-flight guard for reindex so an admin can't pile up concurrent full scans.
const reindexInFlight = new Set<string>();

export async function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  // List documents (metadata only), permission-filtered.
  app.get<{ Querystring: { workspaceId?: string; folderId?: string } }>(
    "/api/documents",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });

      const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
      const docs = await prisma.document.findMany({
        where: { workspaceId, deletedAt: null, ...(request.query.folderId ? { folderId: request.query.folderId } : {}) },
        orderBy: { path: "asc" },
      });

      const documents = docs
        .map((doc) => ({ doc, role: resolver.documentRole(doc) }))
        .filter((entry) => entry.role !== null)
        .map(({ doc, role }) => ({
          id: doc.id,
          workspaceId: doc.workspaceId,
          folderId: doc.folderId,
          path: doc.path,
          title: doc.title,
          permission: role,
          version: doc.currentVersionId,
          checksum: doc.currentChecksum,
          status: doc.status,
          updatedAt: doc.updatedAt.toISOString(),
        }));
      return { documents };
    },
  );

  // Content search across the workspace: case-insensitive SUBSTRING match over title + the
  // denormalized document body (searchText), permission-filtered. Substring (not full-text)
  // matching is deliberate — users expect "find the text I can see", including stop words like
  // "this" and partial words like "lapt", which Postgres FTS would drop or miss.
  app.get<{ Querystring: { workspaceId?: string; q?: string; limit?: string; canonicalOnly?: string } }>(
    "/api/search",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "search");
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });
      const q = (request.query.q ?? "").trim().slice(0, SEARCH_QUERY_MAX);
      if (!q) return { results: [] };
      const results = await searchDocuments({
        userId: auth.userId,
        workspaceId,
        query: q,
        limit: clampSearchLimit(request.query.limit),
        canonicalOnly: request.query.canonicalOnly === "true" || request.query.canonicalOnly === "1",
      });
      return { results: results.map(({ updatedAt: _updatedAt, ...result }) => result) };
    },
  );

  // Reindex a workspace's searchText from current revision content (manager-gated). Lets an
  // admin make legacy documents — created before search shipped, so searchText is null —
  // content-searchable without shell access. Idempotent; safe to re-run.
  app.post<{ Body: { workspaceId?: string } }>(
    "/api/search/reindex",
    { config: { rateLimit: { max: Number(process.env.REINDEX_RATE_LIMIT_MAX ?? 3), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const workspaceId = request.body?.workspaceId;
      if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });
      if (!(await canManageWorkspace(auth.userId, workspaceId))) return notFound(reply, "Workspace not found.");

      if (reindexInFlight.has(workspaceId)) {
        return reply.code(409).send({ error: "conflict", message: "A reindex is already running for this workspace." });
      }
      reindexInFlight.add(workspaceId);
      try {
        let reindexed = 0;
        let skipped = 0;
        const BATCH = 200;
        let cursor: string | undefined;
        for (;;) {
          // Only legacy/unindexed docs (searchText IS NULL). Normal writes keep searchText current,
          // so this is bounded and idempotent: re-runs after a full pass are cheap.
          const docs = await prisma.document.findMany({
            where: { workspaceId, deletedAt: null, currentVersionId: { not: null }, searchText: null },
            select: { id: true, currentVersionId: true },
            orderBy: { id: "asc" },
            take: BATCH,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          });
          if (docs.length === 0) break;
          cursor = docs[docs.length - 1]!.id;
          for (const doc of docs) {
            const revision = await prisma.documentRevision.findUnique({
              where: { id: doc.currentVersionId! },
              select: { storageKey: true },
            });
            if (!revision) {
              skipped += 1;
              continue;
            }
            try {
              const content = await readContent(revision.storageKey);
              // Guarded write: only if the doc is still the same revision and still unindexed, so a
              // concurrent live edit (which sets a fresh searchText) is never clobbered with stale text.
              const { count } = await prisma.document.updateMany({
                where: { id: doc.id, currentVersionId: doc.currentVersionId, deletedAt: null, searchText: null },
                data: { searchText: searchTextFor(content) },
              });
              if (count > 0) reindexed += 1;
              else skipped += 1;
            } catch {
              skipped += 1;
            }
          }
        }
        await writeAuditEvent({
          workspaceId,
          userId: auth.userId,
          action: "search_reindex",
          targetType: "workspace",
          targetId: workspaceId,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
          metadata: { reindexed, skipped },
        });
        return { reindexed, skipped };
      } finally {
        reindexInFlight.delete(workspaceId);
      }
    },
  );

  // Tree of folders + documents the user can see.
  app.get<{ Querystring: { workspaceId?: string } }>("/api/documents/tree", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const workspaceId = request.query.workspaceId;
    if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });

    const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
    const docs = await prisma.document.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { path: "asc" } });

    const visibleDocs = docs
      .map((doc) => ({ doc, role: resolver.documentRole(doc) }))
      .filter((entry) => entry.role !== null);

    // A folder is visible if the user has a role on it, or it is an ancestor of a visible doc.
    const visibleFolderIds = new Set<string>();
    for (const folder of resolver.folders) {
      if (resolver.folderRole(folder.id)) visibleFolderIds.add(folder.id);
    }
    for (const { doc } of visibleDocs) {
      for (const id of resolver.ancestorFolderIds(doc.folderId)) visibleFolderIds.add(id);
    }

    const folderDefaultRoles = new Map<string, "viewer" | "editor" | "manager" | null>();
    if (resolver.folders.length) {
      const rows = await prisma.folder.findMany({
        where: { id: { in: resolver.folders.map((f) => f.id) } },
        select: { id: true, defaultRole: true },
      });
      for (const row of rows) folderDefaultRoles.set(row.id, row.defaultRole);
    }

    const folders = resolver.folders
      .filter((folder) => visibleFolderIds.has(folder.id))
      .map((folder) => ({
        id: folder.id,
        parentFolderId: folder.parentFolderId,
        name: folder.name,
        slug: folder.slug,
        path: folder.path,
        permission: resolver.folderRole(folder.id),
        defaultRole: folderDefaultRoles.get(folder.id) ?? null,
      }));

    const documents = visibleDocs.map(({ doc, role }) => ({
      id: doc.id,
      folderId: doc.folderId,
      title: doc.title,
      path: doc.path,
      permission: role,
      capabilities: capabilitiesFor(role),
      version: doc.currentVersionId,
      checksum: doc.currentChecksum,
      status: doc.status,
      updatedAt: doc.updatedAt.toISOString(),
    }));
    return { folders, documents };
  });

  // Read a single document with content.
  app.get<{ Params: { id: string } }>("/api/documents/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const doc = await prisma.document.findFirst({
      where: { id: request.params.id, deletedAt: null },
      include: { supersededBy: { select: { id: true, title: true, path: true, deletedAt: true } } },
    });
    if (!doc) return notFound(reply, "Document not found.");
    const role = await resolveDocumentRole(auth.userId, doc.id);
    if (!role) return notFound(reply, "Document not found.");

    let content = "";
    if (doc.currentVersionId) {
      const revision = await prisma.documentRevision.findUnique({
        where: { id: doc.currentVersionId },
        select: { storageKey: true },
      });
      if (revision) content = await readContent(revision.storageKey);
    }
    const context = documentContext(content);
    const aiReadiness = await aiReadinessForDocument({
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      status: doc.status,
      title: doc.title,
      updatedAt: doc.updatedAt,
      context,
    });
    const supersededBy =
      doc.supersededBy && !doc.supersededBy.deletedAt
        ? { id: doc.supersededBy.id, title: doc.supersededBy.title, path: doc.supersededBy.path }
        : null;
    const implementationReadiness = implementationReadinessFor({ status: doc.status, context });
    return {
      id: doc.id,
      workspaceId: doc.workspaceId,
      folderId: doc.folderId,
      path: doc.path,
      title: doc.title,
      permission: role,
      capabilities: capabilitiesFor(role),
      version: doc.currentVersionId,
      checksum: doc.currentChecksum,
      status: doc.status,
      supersededBy,
      content,
      aiReadiness,
      implementationReadiness,
      updatedAt: doc.updatedAt.toISOString(),
    };
  });

  // Download a document as a Markdown file with reconstructed frontmatter (read scope).
  // Not a write: no audit event, no revision. Hidden documents 404 like GET /documents/:id.
  app.get<{ Params: { id: string } }>(
    "/api/documents/:id/download",
    { config: { rateLimit: { max: Number(process.env.DOWNLOAD_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!doc) return notFound(reply, "Document not found.");
      const role = await resolveDocumentRole(auth.userId, doc.id);
      if (!role) return notFound(reply, "Document not found.");

      let content = "";
      if (doc.currentVersionId) {
        const revision = await prisma.documentRevision.findUnique({
          where: { id: doc.currentVersionId },
          select: { storageKey: true },
        });
        if (revision) content = await readContent(revision.storageKey);
      }

      const markdown = buildDownloadMarkdown(
        {
          title: doc.title,
          path: doc.path,
          version: doc.currentVersionId,
          updatedAt: doc.updatedAt.toISOString(),
          checksum: doc.currentChecksum,
        },
        content,
      );
      return reply
        .header("content-type", "text/markdown; charset=utf-8")
        .header("content-disposition", contentDisposition(downloadFilename(doc.path)))
        .send(markdown);
    },
  );

  // Handoff packet: pre-digested view of a document for an agent or human reviewer
  // about to start implementation. Returns the same shape as the MCP tool. Rate-
  // limited because building the packet reads storage + parses the full body.
  app.get<{ Params: { id: string } }>(
    "/api/documents/:id/handoff",
    { config: { rateLimit: { max: Number(process.env.HANDOFF_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const packet = await buildHandoffPacket(auth.userId, request.params.id);
      if (packet.status === "not_found") return notFound(reply, "Document not found.");
      return packet.value;
    },
  );

  // Create a document (requires editor on the target folder).
  app.post<{
    Body: { workspaceId?: string; folderId?: string; title?: string; slug?: string; content?: string };
  }>("/api/documents", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "create");
    const { workspaceId, folderId } = request.body;
    const title = request.body.title?.trim();
    const slug = request.body.slug?.trim().toLowerCase();
    const content = request.body.content ?? "";

    const fields: Record<string, string> = {};
    if (!workspaceId) fields.workspaceId = "workspaceId is required.";
    if (!folderId) fields.folderId = "folderId is required.";
    if (!title) fields.title = "Title is required.";
    if (!slug) fields.slug = "Slug is required.";
    else if (!isValidSlug(slug)) fields.slug = "Slug must be lowercase letters, numbers, and hyphens.";
    if (Object.keys(fields).length > 0) return validationError(reply, fields);

    const folder = await prisma.folder.findFirst({
      where: { id: folderId!, workspaceId: workspaceId!, deletedAt: null },
      select: { id: true },
    });
    if (!folder) return notFound(reply, "Folder not found.");
    const folderRole = await resolveFolderRole(auth.userId, folder.id);
    if (folderRole === null) return notFound(reply, "Folder not found.");
    if (!atLeast(folderRole, "editor")) return forbidden(reply);

    const sum = computeChecksum(content);
    const { storageKey } = await writeContent(content, workspaceId!);

    try {
      const result = await prisma.$transaction(async (tx) => {
        await lockFolderTree(tx, workspaceId!);
        // Read the folder path under the lock so a concurrent folder rename/move/delete
        // cannot make us persist a stale path or attach under a deleted folder.
        const lockedFolder = await tx.folder.findFirst({
          where: { id: folder.id, workspaceId: workspaceId!, deletedAt: null },
          select: { path: true },
        });
        if (!lockedFolder) return { status: "folder_missing" as const };
        const az = await authorizeFolderRole(auth, folder.id, "editor", tx);
        if (!az.ok) return az.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
        const path = buildDocumentPath(lockedFolder.path, slug!);
        if (await siblingSlugTaken(tx, folder.id, slug!)) {
          return { status: "collision" as const };
        }
        const doc = await tx.document.create({
          data: {
            workspaceId: workspaceId!,
            folderId: folder.id,
            title: title!,
            slug: slug!,
            path,
            createdById: auth.userId,
            updatedById: auth.userId,
          },
        });
        const revision = await tx.documentRevision.create({
          data: {
            documentId: doc.id,
            versionNumber: 1,
            storageKey,
            checksum: sum,
            createdById: auth.userId,
            changeSource: "web_app",
            contributorIds: [auth.userId],
          },
        });
        const metadata = await metadataFromContent(tx, workspaceId!, content, doc.id);
        const updated = await tx.document.update({
          where: { id: doc.id },
          data: {
            currentVersionId: revision.id,
            currentChecksum: sum,
            searchText: searchTextFor(content),
            status: metadata.status,
            supersededById: metadata.supersededById,
          },
        });
        await writeAuditEvent(
          {
            workspaceId: workspaceId!,
            userId: auth.userId,
            action: "document_created",
            targetType: "document",
            targetId: doc.id,
            metadata: { path, version: revision.id },
          },
          tx,
        );
        return { status: "ok" as const, id: doc.id, version: revision.id, checksum: sum, path: updated.path };
      });

      if (result.status === "folder_missing" || result.status === "not_found") return notFound(reply, "Folder not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "collision") {
        return validationError(reply, { slug: "A document with this slug already exists in the folder." });
      }
      return reply.code(201).send({ id: result.id, version: result.version, checksum: result.checksum, path: result.path });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return validationError(reply, { slug: "A document with this slug or path already exists." });
      }
      throw error;
    }
  });

  // Update from the web app.
  app.put<{ Params: { id: string }; Body: { baseVersion?: string; title?: string; content?: string } }>(
    "/api/documents/:id",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const baseVersion = request.body.baseVersion;
      if (!baseVersion) return validationError(reply, { baseVersion: "baseVersion is required." });
      if (request.body.content === undefined) return validationError(reply, { content: "content is required." });

      const outcome = await applyDocumentWrite({
        documentId: request.params.id,
        auth,
        baseVersion,
        content: request.body.content,
        title: request.body.title?.trim(),
        changeSource: "web_app",
      });
      return sendWriteOutcome(reply, outcome);
    },
  );

  // Push from the Obsidian plugin.
  app.post<{ Params: { id: string }; Body: { baseVersion?: string; checksum?: string; content?: string } }>(
    "/api/documents/:id/push",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const baseVersion = request.body.baseVersion;
      if (!baseVersion) return validationError(reply, { baseVersion: "baseVersion is required." });
      if (request.body.content === undefined) return validationError(reply, { content: "content is required." });
      if (request.body.checksum && request.body.checksum !== computeChecksum(request.body.content)) {
        return validationError(reply, { checksum: "Checksum does not match the submitted content." });
      }

      const outcome = await applyDocumentWrite({
        documentId: request.params.id,
        auth,
        baseVersion,
        content: request.body.content,
        changeSource: "obsidian_plugin",
      });
      return sendWriteOutcome(reply, outcome);
    },
  );

  // Rename (manager): change title/slug, recompute path.
  app.post<{ Params: { id: string }; Body: { title?: string; slug?: string } }>(
    "/api/documents/:id/rename",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const slug = request.body.slug?.trim().toLowerCase();
      if (!slug) return validationError(reply, { slug: "Slug is required." });
      if (!isValidSlug(slug)) return validationError(reply, { slug: "Slug must be lowercase letters, numbers, and hyphens." });

      const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!doc) return notFound(reply, "Document not found.");
      const role = await resolveDocumentRole(auth.userId, doc.id);
      if (role === null) return notFound(reply, "Document not found.");
      if (!atLeast(role, "manager")) return forbidden(reply);

      const title = request.body.title?.trim() ?? doc.title;

      const result = await prisma
        .$transaction(async (tx) => {
          await lockFolderTree(tx, doc.workspaceId);
          const lockedDoc = await tx.$queryRaw<Array<{ folderId: string }>>`
            SELECT "folderId" FROM "Document" WHERE "id" = ${doc.id} AND "deletedAt" IS NULL FOR UPDATE`;
          if (lockedDoc.length === 0) return { status: "gone" as const };
          const az = await authorizeDocumentRole(auth, doc.id, "manager", tx);
          if (!az.ok) return az.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
          const folderId = lockedDoc[0]!.folderId;
          const folder = await tx.folder.findFirst({ where: { id: folderId, deletedAt: null }, select: { path: true } });
          if (!folder) return { status: "folder_missing" as const };
          const path = buildDocumentPath(folder.path, slug);
          if (await siblingSlugTaken(tx, folderId, slug, doc.id)) return { status: "collision" as const };
          const updated = await tx.document.update({
            where: { id: doc.id },
            data: { slug, title, path, updatedById: auth.userId },
          });
          await writeAuditEvent(
            { workspaceId: doc.workspaceId, userId: auth.userId, action: "document_renamed", targetType: "document", targetId: doc.id, metadata: { path } },
            tx,
          );
          return { status: "ok" as const, path: updated.path };
        })
        .catch((error) => {
          if (isUniqueViolation(error)) return { status: "collision" as const };
          throw error;
        });
      if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Document not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "folder_missing") return notFound(reply, "Folder not found.");
      if (result.status === "collision") return validationError(reply, { slug: "A document with this slug already exists in the folder." });
      return { id: doc.id, path: result.path };
    },
  );

  // Move (manager on doc + editor on destination folder).
  app.post<{ Params: { id: string }; Body: { folderId?: string } }>(
    "/api/documents/:id/move",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const destFolderId = request.body.folderId;
      if (!destFolderId) return validationError(reply, { folderId: "folderId is required." });

      const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!doc) return notFound(reply, "Document not found.");
      const docRole = await resolveDocumentRole(auth.userId, doc.id);
      if (docRole === null) return notFound(reply, "Document not found.");
      if (!atLeast(docRole, "manager")) return forbidden(reply);

      const dest = await prisma.folder.findFirst({
        where: { id: destFolderId, workspaceId: doc.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!dest) return notFound(reply, "Destination folder not found.");
      const destRole = await resolveFolderRole(auth.userId, dest.id);
      if (destRole === null) return notFound(reply, "Destination folder not found.");
      if (!atLeast(destRole, "editor")) return forbidden(reply);

      const result = await prisma
        .$transaction(async (tx) => {
          await lockFolderTree(tx, doc.workspaceId);
          const lockedDoc = await tx.$queryRaw<Array<{ slug: string }>>`
            SELECT "slug" FROM "Document" WHERE "id" = ${doc.id} AND "deletedAt" IS NULL FOR UPDATE`;
          if (lockedDoc.length === 0) return { status: "gone" as const };
          const azDoc = await authorizeDocumentRole(auth, doc.id, "manager", tx);
          if (!azDoc.ok) return azDoc.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
          const destFolder = await tx.folder.findFirst({
            where: { id: destFolderId, workspaceId: doc.workspaceId, deletedAt: null },
            select: { path: true },
          });
          if (!destFolder) return { status: "dest_missing" as const };
          const azDest = await authorizeFolderRole(auth, destFolderId, "editor", tx);
          if (!azDest.ok) return azDest.status === "not_found" ? { status: "dest_missing" as const } : { status: "forbidden" as const };
          const slug = lockedDoc[0]!.slug;
          const path = buildDocumentPath(destFolder.path, slug);
          if (await siblingSlugTaken(tx, destFolderId, slug)) return { status: "collision" as const };
          const updated = await tx.document.update({
            where: { id: doc.id },
            data: { folderId: destFolderId, path, updatedById: auth.userId },
          });
          await writeAuditEvent(
            { workspaceId: doc.workspaceId, userId: auth.userId, action: "document_moved", targetType: "document", targetId: doc.id, metadata: { folderId: destFolderId, path } },
            tx,
          );
          return { status: "ok" as const, path: updated.path };
        })
        .catch((error) => {
          if (isUniqueViolation(error)) return { status: "collision" as const };
          throw error;
        });
      if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Document not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "dest_missing") return notFound(reply, "Destination folder not found.");
      if (result.status === "collision") return validationError(reply, { slug: "A document with this slug already exists in the destination folder." });
      return { id: doc.id, folderId: destFolderId, path: result.path };
    },
  );

  // Soft delete (manager).
  app.delete<{ Params: { id: string } }>("/api/documents/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!doc) return notFound(reply, "Document not found.");
    const role = await resolveDocumentRole(auth.userId, doc.id);
    if (role === null) return notFound(reply, "Document not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);

    const deletedAt = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await lockFolderTree(tx, doc.workspaceId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Document" WHERE "id" = ${doc.id} AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length === 0) return { status: "gone" as const };
      const az = await authorizeDocumentRole(auth, doc.id, "manager", tx);
      if (!az.ok) return az.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
      await tx.document.update({ where: { id: doc.id }, data: { deletedAt } });
      await tx.permission.deleteMany({ where: { workspaceId: doc.workspaceId, resourceType: "document", resourceId: doc.id } });
      await writeAuditEvent(
        { workspaceId: doc.workspaceId, userId: auth.userId, action: "document_deleted", targetType: "document", targetId: doc.id },
        tx,
      );
      return { status: "ok" as const };
    });
    if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Document not found.");
    if (result.status === "forbidden") return forbidden(reply);
    return { ok: true, deletedAt: deletedAt.toISOString() };
  });

  // Revisions list (viewer).
  app.get<{ Params: { id: string } }>("/api/documents/:id/revisions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
    if (!doc) return notFound(reply, "Document not found.");
    if (!(await resolveDocumentRole(auth.userId, doc.id))) return notFound(reply, "Document not found.");

    const revisions = await prisma.documentRevision.findMany({
      where: { documentId: doc.id, prunedAt: null },
      orderBy: { versionNumber: "desc" },
    });
    return { revisions: groupedRevisionList(revisions) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/documents/:id/history",
    { config: { rateLimit: { max: Number(process.env.DOCUMENT_HISTORY_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
      if (!doc) return notFound(reply, "Document not found.");
      if (!(await resolveDocumentRole(auth.userId, doc.id))) return notFound(reply, "Document not found.");

      const revisions = groupedRevisionList(
        await prisma.documentRevision.findMany({
          where: { documentId: doc.id, prunedAt: null },
          orderBy: { versionNumber: "desc" },
        }),
      );
      const events = await prisma.auditEvent.findMany({
        where: { targetType: "document", targetId: doc.id, action: { in: [...HISTORY_EVENT_ACTIONS] } },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const timeline = [
        ...revisions.map((revision) => ({ type: "revision" as const, id: `revision:${revision.id}`, createdAt: revision.createdAt, revision })),
        ...events.map((event) => ({
          type: "event" as const,
          id: `event:${event.id}`,
          createdAt: event.createdAt.toISOString(),
          event: {
            action: event.action,
            actor: historyActorFor(event.action, event.metadata, event.userId),
            userId: event.userId,
            targetType: event.targetType,
            targetId: event.targetId,
            metadata: event.metadata ?? null,
          },
        })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return { revisions, timeline };
    },
  );

  // Single revision preview (viewer). The list endpoint stays metadata-only; this endpoint returns
  // the selected snapshot body. Revision titles are not snapshotted today, so return the current
  // document title alongside the revision instead of pretending it is historical.
  app.get<{ Params: { id: string; revisionId: string } }>(
    "/api/documents/:id/revisions/:revisionId",
    { config: { rateLimit: { max: Number(process.env.REVISION_DETAIL_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const doc = await prisma.document.findFirst({
        where: { id: request.params.id, deletedAt: null },
        select: { id: true, title: true },
      });
      if (!doc) return notFound(reply, "Document not found.");
      if (!(await resolveDocumentRole(auth.userId, doc.id))) return notFound(reply, "Document not found.");

      const revision = await prisma.documentRevision.findFirst({
        where: { id: request.params.revisionId, documentId: doc.id, prunedAt: null },
        include: { createdBy: { select: { id: true, name: true, email: true } } },
      });
      if (!revision) return notFound(reply, "Revision not found.");

      const content = await readContent(revision.storageKey);
      return {
        revision: {
          id: revision.id,
          documentId: doc.id,
          versionNumber: revision.versionNumber,
          content,
          checksum: revision.checksum,
          changeSource: revision.changeSource,
          message: revision.message,
          contributorIds: revision.contributorIds,
          isPinned: revision.isPinned,
          label: revision.label,
          createdAt: revision.createdAt.toISOString(),
          createdBy: {
            id: revision.createdBy.id,
            name: revision.createdBy.name,
            email: revision.createdBy.email,
            avatarUrl: null,
          },
        },
        document: { id: doc.id, currentTitle: doc.title },
      };
    },
  );

  app.patch<{ Params: { id: string; revisionId: string }; Body: { label?: string | null; isPinned?: boolean } }>(
    "/api/documents/:id/revisions/:revisionId",
    { config: { rateLimit: { max: Number(process.env.REVISION_METADATA_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const doc = await prisma.document.findFirst({
        where: { id: request.params.id, deletedAt: null },
        select: { id: true, workspaceId: true },
      });
      if (!doc) return notFound(reply, "Document not found.");
      const role = await resolveDocumentRole(auth.userId, doc.id);
      if (role === null) return notFound(reply, "Document not found.");
      if (!atLeast(role, "manager")) return forbidden(reply);

      const label = request.body.label === null ? null : typeof request.body.label === "string" ? request.body.label.trim().slice(0, 80) : undefined;
      const data: { label?: string | null; isPinned?: boolean } = {};
      if (label !== undefined) data.label = label || null;
      if (typeof request.body.isPinned === "boolean") data.isPinned = request.body.isPinned;
      if (!("label" in data) && !("isPinned" in data)) return validationError(reply, { metadata: "label or isPinned is required." });

      const revision = await prisma.documentRevision.updateMany({
        where: { id: request.params.revisionId, documentId: doc.id, prunedAt: null },
        data,
      });
      if (revision.count === 0) return notFound(reply, "Revision not found.");
      await writeAuditEvent({
        workspaceId: doc.workspaceId,
        userId: auth.userId,
        action: "document_revision_metadata_updated",
        targetType: "document",
        targetId: doc.id,
        metadata: { revisionId: request.params.revisionId, ...data },
      });
      return { ok: true };
    },
  );

  // Restore an older revision as a new current revision (manager).
  app.post<{ Params: { id: string; revisionId: string } }>(
    "/api/documents/:id/revisions/:revisionId/restore",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!doc) return notFound(reply, "Document not found.");
      const role = await resolveDocumentRole(auth.userId, doc.id);
      if (role === null) return notFound(reply, "Document not found.");
      if (!atLeast(role, "manager")) return forbidden(reply);

      const source = await prisma.documentRevision.findFirst({
        where: { id: request.params.revisionId, documentId: doc.id, prunedAt: null },
      });
      if (!source) return notFound(reply, "Revision not found.");

      const result = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Document" WHERE "id" = ${doc.id} AND "deletedAt" IS NULL FOR UPDATE`;
        if (locked.length === 0) return { status: "gone" as const };
        const az = await authorizeDocumentRole(auth, doc.id, "manager", tx);
        if (!az.ok) return az.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
        const max = await tx.documentRevision.aggregate({ where: { documentId: doc.id }, _max: { versionNumber: true } });
        const revision = await tx.documentRevision.create({
          data: {
            documentId: doc.id,
            versionNumber: (max._max.versionNumber ?? 0) + 1,
            storageKey: source.storageKey,
            checksum: source.checksum,
            createdById: auth.userId,
            changeSource: "system",
            message: `Restored from revision ${source.versionNumber}`,
            contributorIds: [auth.userId],
          },
        });
        const restoredText = await readContent(source.storageKey);
        const metadata = await metadataFromContent(tx, doc.workspaceId, restoredText, doc.id);
        const updated = await tx.document.update({
          where: { id: doc.id },
          data: {
            currentVersionId: revision.id,
            currentChecksum: source.checksum,
            searchText: searchTextFor(restoredText),
            updatedById: auth.userId,
            status: metadata.status,
            supersededById: metadata.supersededById,
          },
        });
        await writeAuditEvent(
          { workspaceId: doc.workspaceId, userId: auth.userId, action: "document_restored", targetType: "document", targetId: doc.id, metadata: { version: revision.id, from: source.id } },
          tx,
        );
        return { status: "ok" as const, version: revision.id, checksum: source.checksum, updatedAt: updated.updatedAt };
      });
      if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Document not found.");
      if (result.status === "forbidden") return forbidden(reply);
      return { id: doc.id, version: result.version, checksum: result.checksum, updatedAt: result.updatedAt.toISOString() };
    },
  );
}

// Shared by GET /api/documents/:id/handoff and the MCP pageden_get_task_packet tool
// so the wire shape never drifts. Returns either the packet or a sentinel for the
// caller to translate into the right error (HTTP 404 vs MCP "Document not found.").
export async function buildHandoffPacket(
  userId: string,
  documentId: string,
): Promise<{ status: "ok"; value: { workspaceId: string; documentId: string; title: string; path: string; updatedAt: string; packet: TaskPacket } } | { status: "not_found" }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    include: { supersededBy: { select: { id: true, title: true, path: true, deletedAt: true } } },
  });
  if (!doc) return { status: "not_found" };
  const role = await resolveDocumentRole(userId, doc.id);
  if (!role) return { status: "not_found" };

  let content = "";
  if (doc.currentVersionId) {
    const revision = await prisma.documentRevision.findUnique({
      where: { id: doc.currentVersionId },
      select: { storageKey: true },
    });
    if (revision) content = await readContent(revision.storageKey);
  }
  const context = documentContext(content);
  const comments = await prisma.documentComment.findMany({
    where: { documentId: doc.id, resolvedAt: null },
    select: { id: true, body: true, sectionAnchor: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const supersededBy =
    doc.supersededBy && !doc.supersededBy.deletedAt
      ? { id: doc.supersededBy.id, title: doc.supersededBy.title, path: doc.supersededBy.path }
      : null;
  const packet = taskPacketFor({ status: doc.status, supersededBy, context, comments });
  return {
    status: "ok",
    value: {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      title: doc.title,
      path: doc.path,
      updatedAt: doc.updatedAt.toISOString(),
      packet,
    },
  };
}

function sendWriteOutcome(reply: import("fastify").FastifyReply, outcome: WriteOutcome) {
  if (outcome.ok) {
    return reply.send({
      id: outcome.documentId,
      version: outcome.version,
      checksum: outcome.checksum,
      updatedAt: outcome.updatedAt?.toISOString(),
    });
  }
  if (outcome.status === "not_found") return notFound(reply, "Document not found.");
  if (outcome.status === "forbidden") return forbidden(reply, "You do not have permission to edit this document.");
  return conflict(reply, outcome.currentVersion ?? "", "This document changed on the server after you downloaded it.");
}
