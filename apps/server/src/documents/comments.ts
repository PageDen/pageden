import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole } from "../permissions/index.js";

// Inline comments live alongside the document but are NOT part of the doc
// content — they're a coordination signal so multiple agents/humans can leave
// notes without rewriting prose, and so the next reader sees open questions at
// a glance. Permissions:
//   * read: anyone who can read the doc
//   * create: anyone who can read the doc (any role)
//   * resolve / delete: the original author OR a manager on the doc
const MAX_BODY = 4_000;
const MAX_LABEL = 80;
const MAX_NOTE = 400;
const MAX_SECTION_ANCHOR = 200;

function clip(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function authorLabelFor(auth: AuthContext, fallback: string | null): string {
  if (auth.tokenName) return `${auth.tokenName} (${auth.tokenKind ?? "agent"})`;
  return fallback ?? "user";
}

interface CommentRow {
  id: string;
  workspaceId: string;
  documentId: string;
  sectionAnchor: string | null;
  authorUserId: string | null;
  authorTokenId: string | null;
  authorLabel: string | null;
  body: string;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toCommentDto(row: CommentRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    sectionAnchor: row.sectionAnchor,
    body: row.body,
    authorUserId: row.authorUserId,
    authorTokenId: row.authorTokenId,
    authorLabel: row.authorLabel,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedById: row.resolvedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createComment(
  auth: AuthContext,
  documentId: string,
  input: { body: string; sectionAnchor?: string | null },
): Promise<{ status: "ok"; comment: ReturnType<typeof toCommentDto> } | { status: "not_found" } | { status: "validation"; field: string; message: string }> {
  const body = clip(input.body, MAX_BODY);
  if (!body) return { status: "validation", field: "body", message: "Comment body is required." };
  const sectionAnchor = clip(input.sectionAnchor ?? null, MAX_SECTION_ANCHOR);

  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true, folderId: true },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };

  const created = await prisma.documentComment.create({
    data: {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      sectionAnchor,
      authorUserId: auth.userId,
      authorTokenId: auth.tokenId ?? null,
      authorLabel: clip(authorLabelFor(auth, null), MAX_LABEL),
      body,
    },
  });
  await writeAuditEvent({
    workspaceId: doc.workspaceId,
    userId: auth.userId,
    action: auth.tokenKind === "agent" ? "comment_added_by_agent" : "comment_added",
    targetType: "document_comment",
    targetId: created.id,
    metadata: { documentId: doc.id, sectionAnchor, tokenId: auth.tokenId, tokenKind: auth.tokenKind },
  });
  return { status: "ok", comment: toCommentDto(created) };
}

export async function listComments(
  auth: AuthContext,
  documentId: string,
  opts: { includeResolved: boolean },
): Promise<{ status: "ok"; comments: ReturnType<typeof toCommentDto>[] } | { status: "not_found" }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };

  const where = opts.includeResolved ? { documentId: doc.id } : { documentId: doc.id, resolvedAt: null };
  const rows = await prisma.documentComment.findMany({
    where,
    orderBy: [{ resolvedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  return { status: "ok", comments: rows.map(toCommentDto) };
}

export async function resolveCommentRecord(
  auth: AuthContext,
  commentId: string,
): Promise<{ status: "ok"; comment: ReturnType<typeof toCommentDto> } | { status: "not_found" } | { status: "forbidden" }> {
  const comment = await prisma.documentComment.findUnique({ where: { id: commentId } });
  if (!comment) return { status: "not_found" };
  if (auth.tokenWorkspaceId && comment.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, comment.documentId);
  if (!role) return { status: "not_found" };
  const isAuthor = comment.authorUserId === auth.userId;
  if (!isAuthor && !atLeast(role, "manager")) return { status: "forbidden" };

  if (comment.resolvedAt) {
    // Already resolved — return the existing row idempotently so an agent retry
    // (network blip, restart) doesn't trip a 404 or a duplicate audit event.
    return { status: "ok", comment: toCommentDto(comment) };
  }
  const updated = await prisma.documentComment.update({
    where: { id: comment.id },
    data: { resolvedAt: new Date(), resolvedById: auth.userId },
  });
  await writeAuditEvent({
    workspaceId: comment.workspaceId,
    userId: auth.userId,
    action: auth.tokenKind === "agent" ? "comment_resolved_by_agent" : "comment_resolved",
    targetType: "document_comment",
    targetId: comment.id,
    metadata: { documentId: comment.documentId, tokenId: auth.tokenId },
  });
  return { status: "ok", comment: toCommentDto(updated) };
}

export async function deleteCommentRecord(
  auth: AuthContext,
  commentId: string,
): Promise<{ status: "ok" } | { status: "not_found" } | { status: "forbidden" }> {
  const comment = await prisma.documentComment.findUnique({ where: { id: commentId } });
  if (!comment) return { status: "not_found" };
  if (auth.tokenWorkspaceId && comment.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, comment.documentId);
  if (!role) return { status: "not_found" };
  const isAuthor = comment.authorUserId === auth.userId;
  if (!isAuthor && !atLeast(role, "manager")) return { status: "forbidden" };

  await prisma.documentComment.delete({ where: { id: comment.id } });
  await writeAuditEvent({
    workspaceId: comment.workspaceId,
    userId: auth.userId,
    action: "comment_deleted",
    targetType: "document_comment",
    targetId: comment.id,
    metadata: { documentId: comment.documentId },
  });
  return { status: "ok" };
}

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { includeResolved?: string } }>(
    "/api/documents/:id/comments",
    { config: { rateLimit: { max: Number(process.env.COMMENTS_READ_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const includeResolved = request.query.includeResolved === "true" || request.query.includeResolved === "1";
      const result = await listComments(auth, request.params.id, { includeResolved });
      if (result.status === "not_found") return notFound(reply, "Document not found.");
      return { comments: result.comments };
    },
  );

  app.post<{ Params: { id: string }; Body: { body?: string; sectionAnchor?: string | null } }>(
    "/api/documents/:id/comments",
    { config: { rateLimit: { max: Number(process.env.COMMENTS_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "create");
      const result = await createComment(auth, request.params.id, {
        body: request.body?.body ?? "",
        sectionAnchor: request.body?.sectionAnchor ?? null,
      });
      if (result.status === "not_found") return notFound(reply, "Document not found.");
      if (result.status === "validation") return validationError(reply, { [result.field]: result.message });
      return reply.code(201).send({ comment: result.comment });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/comments/:id/resolve",
    { config: { rateLimit: { max: Number(process.env.COMMENTS_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const result = await resolveCommentRecord(auth, request.params.id);
      if (result.status === "not_found") return notFound(reply, "Comment not found.");
      if (result.status === "forbidden") return forbidden(reply);
      return { comment: result.comment };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/comments/:id",
    { config: { rateLimit: { max: Number(process.env.COMMENTS_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const result = await deleteCommentRecord(auth, request.params.id);
      if (result.status === "not_found") return notFound(reply, "Comment not found.");
      if (result.status === "forbidden") return forbidden(reply);
      return { ok: true };
    },
  );
}

// Re-exported for the dashboard / handoff packet so they can show open
// comment counts without duplicating the permission gate.
export async function openCommentCountByDocument(documentIds: string[]): Promise<Map<string, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await prisma.documentComment.groupBy({
    by: ["documentId"],
    where: { documentId: { in: documentIds }, resolvedAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.documentId, row._count._all]));
}

// Allow the route layer to keep using these names without importing each one.
export const COMMENT_MAX_BODY = MAX_BODY;
export const COMMENT_MAX_NOTE_DEFER = MAX_NOTE; // exported for the claims module to share the cap
