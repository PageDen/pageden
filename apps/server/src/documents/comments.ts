import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole } from "../permissions/index.js";
import { env } from "../env.js";
import { getMailer } from "../mailer.js";

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
const MAX_MENTIONS = 20;

function stripDocumentExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function documentUrl(workspaceId: string, path: string, commentId?: string): string {
  const readablePath = stripDocumentExtension(path)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const hash = commentId ? `#comment-${encodeURIComponent(commentId)}` : "";
  return `${env.appUrl}/w/${encodeURIComponent(workspaceId)}/p/${readablePath}${hash}`;
}

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
  mentions?: Array<{ userId: string }>;
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
    mentionedUserIds: row.mentions?.map((mention) => mention.userId) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeMentionedUserIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const ids = input.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_MENTIONS);
}

async function visibleMentionTargets(documentId: string, userIds: string[]): Promise<Set<string>> {
  const visible = new Set<string>();
  for (const userId of userIds) {
    if (await resolveDocumentRole(userId, documentId)) visible.add(userId);
  }
  return visible;
}

async function writeCommentMentionEmailAudit(input: {
  workspaceId: string;
  documentId: string;
  commentId: string;
  actorUserId: string;
  recipientUserId: string;
  recipientEmail: string;
  status: "sent" | "failed";
  error?: unknown;
  log: { warn: (payload: object, message?: string) => void };
}): Promise<void> {
  try {
    await writeAuditEvent({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      action: input.status === "sent" ? "comment_mention_email_sent" : "comment_mention_email_failed",
      targetType: "document_comment",
      targetId: input.commentId,
      metadata: {
        documentId: input.documentId,
        recipientUserId: input.recipientUserId,
        recipientEmail: input.recipientEmail,
        ...(input.error instanceof Error ? { error: input.error.message } : input.error ? { error: String(input.error) } : {}),
      },
    });
  } catch (auditErr) {
    input.log.warn({ err: auditErr, commentId: input.commentId }, "comment mention email audit write failed");
  }
}

async function sendCommentMentionNotifications(input: {
  auth: AuthContext;
  doc: { id: string; workspaceId: string; title: string; path: string; workspace: { name: string } };
  comment: ReturnType<typeof toCommentDto>;
  recipients: Array<{ id: string; email: string; name: string }>;
  log: { warn: (payload: object, message?: string) => void };
}): Promise<void> {
  const actor = await prisma.user.findUnique({ where: { id: input.auth.userId }, select: { email: true, name: true } });
  const openUrl = documentUrl(input.doc.workspaceId, input.doc.path, input.comment.id);
  await Promise.all(
    input.recipients.map(async (recipient) => {
      try {
        await getMailer().sendCommentMentioned(recipient.email, {
          actorName: actor?.name || actor?.email || "A teammate",
          actorEmail: actor?.email,
          workspaceName: input.doc.workspace.name,
          documentTitle: input.doc.title,
          documentPath: input.doc.path,
          commentBody: input.comment.body,
          openUrl,
        });
        await writeCommentMentionEmailAudit({
          workspaceId: input.doc.workspaceId,
          documentId: input.doc.id,
          commentId: input.comment.id,
          actorUserId: input.auth.userId,
          recipientUserId: recipient.id,
          recipientEmail: recipient.email,
          status: "sent",
          log: input.log,
        });
      } catch (err) {
        input.log.warn({ err, commentId: input.comment.id, recipientUserId: recipient.id }, "comment mention email failed");
        await writeCommentMentionEmailAudit({
          workspaceId: input.doc.workspaceId,
          documentId: input.doc.id,
          commentId: input.comment.id,
          actorUserId: input.auth.userId,
          recipientUserId: recipient.id,
          recipientEmail: recipient.email,
          status: "failed",
          error: err,
          log: input.log,
        });
      }
    }),
  );
}

export async function createComment(
  auth: AuthContext,
  documentId: string,
  input: { body: string; sectionAnchor?: string | null; mentionedUserIds?: unknown },
  log: { warn: (payload: object, message?: string) => void } = console,
): Promise<{ status: "ok"; comment: ReturnType<typeof toCommentDto> } | { status: "not_found" } | { status: "validation"; field: string; message: string }> {
  const body = clip(input.body, MAX_BODY);
  if (!body) return { status: "validation", field: "body", message: "Comment body is required." };
  const sectionAnchor = clip(input.sectionAnchor ?? null, MAX_SECTION_ANCHOR);

  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true, folderId: true, title: true, path: true, workspace: { select: { name: true } } },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };
  const mentionedUserIds = normalizeMentionedUserIds(input.mentionedUserIds);
  const visibleMentionedUserIds = await visibleMentionTargets(doc.id, mentionedUserIds);
  const invalidMention = mentionedUserIds.find((userId) => !visibleMentionedUserIds.has(userId));
  if (invalidMention) return { status: "validation", field: "mentionedUserIds", message: "Every mentioned user must be able to read this document." };

  const created = await prisma.documentComment.create({
    data: {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      sectionAnchor,
      authorUserId: auth.userId,
      authorTokenId: auth.tokenId ?? null,
      authorLabel: clip(authorLabelFor(auth, null), MAX_LABEL),
      body,
      mentions:
        mentionedUserIds.length > 0
          ? { createMany: { data: mentionedUserIds.map((userId) => ({ workspaceId: doc.workspaceId, documentId: doc.id, userId })) } }
          : undefined,
    },
    include: { mentions: { select: { userId: true } } },
  });
  await writeAuditEvent({
    workspaceId: doc.workspaceId,
    userId: auth.userId,
    action: auth.tokenKind === "agent" ? "comment_added_by_agent" : "comment_added",
    targetType: "document_comment",
    targetId: created.id,
    metadata: { documentId: doc.id, sectionAnchor, tokenId: auth.tokenId, tokenKind: auth.tokenKind },
  });
  const comment = toCommentDto(created);
  const notifyUserIds = mentionedUserIds;
  if (notifyUserIds.length > 0) {
    const recipients = await prisma.user.findMany({ where: { id: { in: notifyUserIds } }, select: { id: true, email: true, name: true } });
    await sendCommentMentionNotifications({ auth, doc, comment, recipients, log });
  }
  return { status: "ok", comment };
}

export async function listCommentMentionUsers(
  auth: AuthContext,
  documentId: string,
): Promise<{ status: "ok"; users: Array<{ id: string; email: string; name: string }> } | { status: "not_found" }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };

  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId: doc.workspaceId },
    select: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { user: { email: "asc" } },
  });
  const users: Array<{ id: string; email: string; name: string }> = [];
  for (const membership of memberships) {
    if (await resolveDocumentRole(membership.user.id, doc.id)) users.push(membership.user);
  }
  return { status: "ok", users };
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
    include: { mentions: { select: { userId: true } } },
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
        mentionedUserIds: (request.body as { mentionedUserIds?: unknown } | undefined)?.mentionedUserIds,
      }, request.log);
      if (result.status === "not_found") return notFound(reply, "Document not found.");
      if (result.status === "validation") return validationError(reply, { [result.field]: result.message });
      return reply.code(201).send({ comment: result.comment });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/documents/:id/comment-mention-users",
    { config: { rateLimit: { max: Number(process.env.COMMENTS_READ_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const result = await listCommentMentionUsers(auth, request.params.id);
      if (result.status === "not_found") return notFound(reply, "Document not found.");
      return { users: result.users };
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
