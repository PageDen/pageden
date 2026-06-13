import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { ChangeSource } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { canonicalize, checksum as computeChecksum } from "../checksum.js";
import { aiReadinessForDocument, documentContext } from "../ai-readiness.js";

// searchText denormalizes current content for FTS. Cap the indexed text so a pathological
// document cannot bloat the row or exceed Postgres's tsvector size limit (~1MB of lexemes).
const SEARCH_TEXT_MAX = 200_000;
export function searchTextFor(content: string): string {
  // Strip the private-use highlight markers so they can only ever come from ts_headline, never
  // from document content (prevents a control/data collision in snippets).
  // eslint-disable-next-line no-control-regex -- intentionally stripping NUL (0x00)
  const canonical = canonicalize(content).replace(/[\uE000\uE001\u0000]/g, "");
  return canonical.length > SEARCH_TEXT_MAX ? canonical.slice(0, SEARCH_TEXT_MAX) : canonical;
}

// Snippet highlighting markers: Unicode Private-Use chars that won't occur in normal documents
// (searchTextFor strips them from stored content). The web layer escapes the snippet text and
// only bolds the spans between these — no raw HTML, so document content can't inject markup.
const HL_START = "\uE000";
const HL_STOP = "\uE001";

// Build a short excerpt around the first case-insensitive occurrence of `q` in the body, with the
// match wrapped in the highlight markers. Returns null when the term isn't in the body (e.g. the
// document only matched on its title).
function buildSnippet(searchText: string | null, q: string): string | null {
  if (!searchText) return null;
  const idx = searchText.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return null;
  const RADIUS = 60;
  const start = Math.max(0, idx - RADIUS);
  const end = Math.min(searchText.length, idx + q.length + RADIUS);
  const before = searchText.slice(start, idx);
  const match = searchText.slice(idx, idx + q.length);
  const after = searchText.slice(idx + q.length, end);
  let frag = `${before}${HL_START}${match}${HL_STOP}${after}`.replace(/\s+/g, " ").trim();
  if (start > 0) frag = `… ${frag}`;
  if (end < searchText.length) frag = `${frag} …`;
  return frag;
}
import { readContent, writeContent } from "../storage.js";
import { buildDocumentPath, isValidSlug } from "../paths.js";
import { conflict, forbidden, isUniqueViolation, notFound, validationError } from "../errors.js";
import { atLeast, authorizeDocumentRole, authorizeFolderRole, canManageWorkspace, resolveDocumentRole, resolveFolderRole } from "../permissions/index.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import { lockFolderTree } from "../db.js";

type Tx = Prisma.TransactionClient;

async function siblingSlugTaken(tx: Tx, folderId: string, slug: string, exceptId?: string): Promise<boolean> {
  const existing = await tx.document.findFirst({
    where: { folderId, slug, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return existing !== null;
}

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
  userId: string;
  baseVersion: string;
  content: string;
  title?: string;
  changeSource: ChangeSource;
}): Promise<WriteOutcome> {
  // Cheap preflight (re-checked authoritatively under the lock below) so a forbidden or stale
  // write does not perform storage work. Avoids a storage/CPU abuse vector.
  const pre = await prisma.document.findFirst({
    where: { id: opts.documentId, deletedAt: null },
    select: { currentVersionId: true, workspaceId: true },
  });
  if (!pre) return { ok: false, status: "not_found" };
  const preRole = await resolveDocumentRole(opts.userId, opts.documentId);
  if (preRole === null) return { ok: false, status: "not_found" };
  if (!atLeast(preRole, "editor")) return { ok: false, status: "forbidden" };
  if ((pre.currentVersionId ?? "") !== opts.baseVersion) {
    return { ok: false, status: "conflict", currentVersion: pre.currentVersionId ?? "" };
  }

  // Content is written before the transaction so the row lock is held only for the DB work.
  // Orphan objects are harmless: storage is content-addressed and idempotent (review H4).
  const sum = computeChecksum(opts.content);
  const { storageKey } = await writeContent(opts.content, pre.workspaceId);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Document" WHERE "id" = ${opts.documentId} AND "deletedAt" IS NULL FOR UPDATE`;
    if (locked.length === 0) return { ok: false, status: "not_found" };

    const role = await resolveDocumentRole(opts.userId, opts.documentId, tx);
    if (role === null) return { ok: false, status: "not_found" };
    if (!atLeast(role, "editor")) return { ok: false, status: "forbidden" };

    const doc = await tx.document.findUniqueOrThrow({ where: { id: opts.documentId } });
    if ((doc.currentVersionId ?? "") !== opts.baseVersion) {
      return { ok: false, status: "conflict", currentVersion: doc.currentVersionId ?? "" };
    }

    const max = await tx.documentRevision.aggregate({
      where: { documentId: doc.id },
      _max: { versionNumber: true },
    });
    const revision = await tx.documentRevision.create({
      data: {
        documentId: doc.id,
        versionNumber: (max._max.versionNumber ?? 0) + 1,
        storageKey,
        checksum: sum,
        createdById: opts.userId,
        changeSource: opts.changeSource,
      },
    });
    const updated = await tx.document.update({
      where: { id: doc.id },
      data: {
        currentVersionId: revision.id,
        currentChecksum: sum,
        searchText: searchTextFor(opts.content),
        updatedById: opts.userId,
        title: opts.title ?? doc.title,
      },
    });
    await writeAuditEvent(
      {
        workspaceId: doc.workspaceId,
        userId: opts.userId,
        action: opts.changeSource === "obsidian_plugin" ? "document_pushed" : "document_updated",
        targetType: "document",
        targetId: doc.id,
        metadata: { version: revision.id },
      },
      tx,
    );
    return { ok: true, documentId: doc.id, version: revision.id, checksum: sum, updatedAt: updated.updatedAt };
  });
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
          updatedAt: doc.updatedAt.toISOString(),
        }));
      return { documents };
    },
  );

  // Content search across the workspace: case-insensitive SUBSTRING match over title + the
  // denormalized document body (searchText), permission-filtered. Substring (not full-text)
  // matching is deliberate — users expect "find the text I can see", including stop words like
  // "this" and partial words like "lapt", which Postgres FTS would drop or miss.
  app.get<{ Querystring: { workspaceId?: string; q?: string; limit?: string } }>(
    "/api/search",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "search");
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });
      const q = (request.query.q ?? "").trim().slice(0, 256);
      if (!q) return { results: [] };
      const rawLimit = Number(request.query.limit ?? 20);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 50) : 20;

      // Permission filtering happens in app code, so we page through ranked matches and keep
      // filtering until we have `limit` readable hits or the candidate set is exhausted, bounded
      // by a hard scan cap. Ranking: title matches first, then most-recently-updated.
      const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
      const PAGE = Math.min(Math.max(limit * 3, 60), 200);
      const SCAN_CAP = 1000;
      const results: Array<{ id: string; title: string; path: string; permission: string }> = [];
      let offset = 0;
      while (results.length < limit && offset < SCAN_CAP) {
        const rows = await prisma.$queryRaw<Array<{ id: string; folderId: string; title: string; path: string }>>`
          SELECT "id", "folderId", "title", "path"
          FROM "Document"
          WHERE "workspaceId" = ${workspaceId}
            AND "deletedAt" IS NULL
            AND strpos(lower(coalesce("title", '') || ' ' || coalesce("searchText", '')), lower(${q})) > 0
          ORDER BY
            (CASE WHEN strpos(lower(coalesce("title", '')), lower(${q})) > 0 THEN 0 ELSE 1 END) ASC,
            "updatedAt" DESC,
            "id" ASC
          LIMIT ${PAGE} OFFSET ${offset}`;
        if (rows.length === 0) break;
        for (const doc of rows) {
          const role = resolver.documentRole({ id: doc.id, folderId: doc.folderId });
          if (role !== null) {
            results.push({ id: doc.id, title: doc.title, path: doc.path, permission: role });
            if (results.length >= limit) break;
          }
        }
        if (rows.length < PAGE) break; // candidate set exhausted
        offset += PAGE;
      }

      if (results.length === 0) return { results: [] };
      // Build body snippets for the final, permission-filtered results.
      const ids = results.map((r) => r.id);
      const bodyRows = await prisma.$queryRaw<Array<{ id: string; searchText: string | null }>>`
        SELECT "id", "searchText" FROM "Document"
        WHERE "id" IN (${Prisma.join(ids)}) AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL`;
      const snippetById = new Map(bodyRows.map((r) => [r.id, buildSnippet(r.searchText, q)]));
      return { results: results.map((r) => ({ ...r, snippet: snippetById.get(r.id) ?? null })) };
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

    const folders = resolver.folders
      .filter((folder) => visibleFolderIds.has(folder.id))
      .map((folder) => ({
        id: folder.id,
        parentFolderId: folder.parentFolderId,
        name: folder.name,
        slug: folder.slug,
        path: folder.path,
        permission: resolver.folderRole(folder.id),
      }));

    const documents = visibleDocs.map(({ doc, role }) => ({
      id: doc.id,
      folderId: doc.folderId,
      title: doc.title,
      path: doc.path,
      permission: role,
      version: doc.currentVersionId,
      checksum: doc.currentChecksum,
      updatedAt: doc.updatedAt.toISOString(),
    }));
    return { folders, documents };
  });

  // Read a single document with content.
  app.get<{ Params: { id: string } }>("/api/documents/:id", async (request, reply) => {
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
    const context = documentContext(content);
    const aiReadiness = await aiReadinessForDocument({
      workspaceId: doc.workspaceId,
      title: doc.title,
      updatedAt: doc.updatedAt,
      context,
    });
    return {
      id: doc.id,
      workspaceId: doc.workspaceId,
      folderId: doc.folderId,
      path: doc.path,
      title: doc.title,
      permission: role,
      version: doc.currentVersionId,
      checksum: doc.currentChecksum,
      content,
      aiReadiness,
      updatedAt: doc.updatedAt.toISOString(),
    };
  });

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
        const az = await authorizeFolderRole(auth.userId, folder.id, "editor", tx);
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
          },
        });
        const updated = await tx.document.update({
          where: { id: doc.id },
          data: { currentVersionId: revision.id, currentChecksum: sum, searchText: searchTextFor(content) },
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
        userId: auth.userId,
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
        userId: auth.userId,
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
          const az = await authorizeDocumentRole(auth.userId, doc.id, "manager", tx);
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
          const azDoc = await authorizeDocumentRole(auth.userId, doc.id, "manager", tx);
          if (!azDoc.ok) return azDoc.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
          const destFolder = await tx.folder.findFirst({
            where: { id: destFolderId, workspaceId: doc.workspaceId, deletedAt: null },
            select: { path: true },
          });
          if (!destFolder) return { status: "dest_missing" as const };
          const azDest = await authorizeFolderRole(auth.userId, destFolderId, "editor", tx);
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
      const az = await authorizeDocumentRole(auth.userId, doc.id, "manager", tx);
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
      where: { documentId: doc.id },
      orderBy: { versionNumber: "desc" },
    });
    return {
      revisions: revisions.map((revision) => ({
        id: revision.id,
        versionNumber: revision.versionNumber,
        checksum: revision.checksum,
        createdBy: revision.createdById,
        createdAt: revision.createdAt.toISOString(),
        changeSource: revision.changeSource,
        message: revision.message,
      })),
    };
  });

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
        where: { id: request.params.revisionId, documentId: doc.id },
      });
      if (!source) return notFound(reply, "Revision not found.");

      const result = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Document" WHERE "id" = ${doc.id} AND "deletedAt" IS NULL FOR UPDATE`;
        if (locked.length === 0) return { status: "gone" as const };
        const az = await authorizeDocumentRole(auth.userId, doc.id, "manager", tx);
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
          },
        });
        const restoredText = await readContent(source.storageKey);
        const updated = await tx.document.update({
          where: { id: doc.id },
          data: { currentVersionId: revision.id, currentChecksum: source.checksum, searchText: searchTextFor(restoredText), updatedById: auth.userId },
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
