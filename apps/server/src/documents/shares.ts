import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole } from "../permissions/index.js";
import { readContent } from "../storage.js";
import { hashToken } from "../tokens.js";

// Public share links: a manager creates a slug-URL anyone can read, optionally
// password-protected and/or time-bombed. Writes go through the existing role
// gate (manager-only); revocation reuses the same gate plus author override.
// Public reads via /s/:slug never authenticate — see public-share-routes.ts.

const MAX_NOTE_PASSWORD = 128;
const MAX_TTL_DAYS = 365;
const SLUG_LENGTH = 24; // ~144 bits of entropy from base64url

function newSlug(): string {
  return randomBytes(SLUG_LENGTH).toString("base64url");
}

function parseTtl(ttlDays: number | undefined): Date | null {
  if (typeof ttlDays !== "number" || !Number.isFinite(ttlDays) || ttlDays <= 0) return null;
  const clamped = Math.min(Math.floor(ttlDays), MAX_TTL_DAYS);
  return new Date(Date.now() + clamped * 24 * 60 * 60 * 1000);
}

interface ShareRow {
  id: string;
  workspaceId: string;
  documentId: string;
  slug: string;
  passwordHash: string | null;
  allowIndexing: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

function shareDto(row: ShareRow) {
  const active = !row.revokedAt && (row.expiresAt === null || row.expiresAt.getTime() > Date.now());
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    slug: row.slug,
    hasPassword: row.passwordHash !== null,
    allowIndexing: row.allowIndexing,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    active,
  };
}

export async function createShare(
  auth: AuthContext,
  documentId: string,
  opts: { ttlDays?: number; password?: string | null; allowIndexing?: boolean },
): Promise<{ status: "ok"; share: ReturnType<typeof shareDto> } | { status: "not_found" } | { status: "forbidden" } | { status: "validation"; field: string; message: string }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };
  if (!atLeast(role, "manager")) return { status: "forbidden" };

  const password = typeof opts.password === "string" ? opts.password.trim() : "";
  if (password && password.length > MAX_NOTE_PASSWORD) {
    return { status: "validation", field: "password", message: `password must be ${MAX_NOTE_PASSWORD} characters or fewer.` };
  }
  const passwordHash = password ? hashToken(password, env.tokenHashSecret) : null;
  const expiresAt = parseTtl(opts.ttlDays);

  // Collision-safe slug generation: retry once if the random slug already exists.
  let slug = newSlug();
  let attempts = 0;
  while (await prisma.documentShare.findUnique({ where: { slug }, select: { id: true } })) {
    if (++attempts >= 3) {
      return { status: "validation", field: "slug", message: "Could not allocate a unique slug. Try again." };
    }
    slug = newSlug();
  }

  const row = await prisma.documentShare.create({
    data: {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      slug,
      passwordHash,
      allowIndexing: opts.allowIndexing === true,
      expiresAt,
      createdById: auth.userId,
    },
  });
  await writeAuditEvent({
    workspaceId: doc.workspaceId,
    userId: auth.userId,
    action: auth.tokenKind === "agent" ? "document_shared_by_agent" : "document_shared",
    targetType: "document_share",
    targetId: row.id,
    metadata: { documentId: doc.id, expiresAt: expiresAt?.toISOString() ?? null, hasPassword: passwordHash !== null, allowIndexing: row.allowIndexing },
  });
  return { status: "ok", share: shareDto(row) };
}

export async function revokeShare(
  auth: AuthContext,
  shareId: string,
): Promise<{ status: "ok"; share: ReturnType<typeof shareDto> } | { status: "not_found" } | { status: "forbidden" }> {
  const share = await prisma.documentShare.findUnique({ where: { id: shareId } });
  if (!share) return { status: "not_found" };
  if (auth.tokenWorkspaceId && share.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, share.documentId);
  if (!role) return { status: "not_found" };
  const isAuthor = share.createdById === auth.userId;
  if (!isAuthor && !atLeast(role, "manager")) return { status: "forbidden" };
  if (share.revokedAt) return { status: "ok", share: shareDto(share) };

  const updated = await prisma.documentShare.update({
    where: { id: share.id },
    data: { revokedAt: new Date() },
  });
  await writeAuditEvent({
    workspaceId: share.workspaceId,
    userId: auth.userId,
    action: auth.tokenKind === "agent" ? "document_share_revoked_by_agent" : "document_share_revoked",
    targetType: "document_share",
    targetId: share.id,
    metadata: { documentId: share.documentId },
  });
  return { status: "ok", share: shareDto(updated) };
}

export async function listShares(
  auth: AuthContext,
  workspaceId: string,
  opts: { documentId?: string; includeRevoked?: boolean },
): Promise<{ status: "ok"; shares: ReturnType<typeof shareDto>[] } | { status: "not_found" }> {
  // Workspace membership is the gate at the list level; per-doc reads are
  // already filtered through resolveDocumentRole inside the loop so a member
  // with no role on a particular doc never sees its slug.
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: auth.userId } },
    select: { workspaceId: true },
  });
  if (!membership) return { status: "not_found" };

  const where: Record<string, unknown> = { workspaceId };
  if (opts.documentId) where.documentId = opts.documentId;
  if (!opts.includeRevoked) where.revokedAt = null;
  const rows = await prisma.documentShare.findMany({ where, orderBy: { createdAt: "desc" } });
  const visible: ShareRow[] = [];
  for (const row of rows) {
    const role = await resolveDocumentRole(auth.userId, row.documentId);
    if (role && atLeast(role, "manager")) visible.push(row);
  }
  return { status: "ok", shares: visible.map(shareDto) };
}

// Public lookup. Returns the share + sanitized Markdown when valid; null
// otherwise. Wrong/missing password returns a sentinel so the public route
// can render a password prompt without leaking the share's existence vs
// existence-but-wrong-password (Outline + Docmost both blur this; we don't).
export type PublicShareResult =
  | { status: "ok"; share: ReturnType<typeof shareDto>; content: string; title: string; path: string }
  | { status: "password_required" }
  | { status: "wrong_password" }
  | { status: "not_found" };

export async function readPublicShare(slug: string, password: string | null): Promise<PublicShareResult> {
  const share = await prisma.documentShare.findUnique({ where: { slug } });
  if (!share) return { status: "not_found" };
  if (share.revokedAt) return { status: "not_found" };
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) return { status: "not_found" };
  if (share.passwordHash) {
    if (!password) return { status: "password_required" };
    const provided = hashToken(password, env.tokenHashSecret);
    if (provided !== share.passwordHash) return { status: "wrong_password" };
  }
  const doc = await prisma.document.findFirst({
    where: { id: share.documentId, deletedAt: null },
    select: { id: true, title: true, path: true, currentVersionId: true },
  });
  if (!doc) return { status: "not_found" };
  let content = "";
  if (doc.currentVersionId) {
    const revision = await prisma.documentRevision.findUnique({
      where: { id: doc.currentVersionId },
      select: { storageKey: true },
    });
    if (revision) content = await readContent(revision.storageKey);
  }
  return { status: "ok", share: shareDto(share), content, title: doc.title, path: doc.path };
}

export async function registerShareRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { ttlDays?: number; password?: string | null; allowIndexing?: boolean } }>(
    "/api/documents/:id/share",
    { config: { rateLimit: { max: Number(process.env.SHARE_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const result = await createShare(auth, request.params.id, {
        ttlDays: request.body?.ttlDays,
        password: request.body?.password ?? null,
        allowIndexing: request.body?.allowIndexing ?? false,
      });
      if (result.status === "not_found") return notFound(reply, "Document not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "validation") return validationError(reply, { [result.field]: result.message });
      return reply.code(201).send({ share: result.share });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/shares/:id",
    { config: { rateLimit: { max: Number(process.env.SHARE_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const result = await revokeShare(auth, request.params.id);
      if (result.status === "not_found") return notFound(reply, "Share not found.");
      if (result.status === "forbidden") return forbidden(reply);
      return { share: result.share };
    },
  );

  app.get<{ Params: { workspaceId: string }; Querystring: { documentId?: string; includeRevoked?: string } }>(
    "/api/workspaces/:workspaceId/shares",
    { config: { rateLimit: { max: Number(process.env.SHARE_READ_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const includeRevoked = request.query.includeRevoked === "true" || request.query.includeRevoked === "1";
      const result = await listShares(auth, request.params.workspaceId, {
        documentId: request.query.documentId,
        includeRevoked,
      });
      if (result.status === "not_found") return notFound(reply, "Workspace not found.");
      return { workspaceId: request.params.workspaceId, shares: result.shares };
    },
  );
}

// Anonymous /s/:slug route lives in shares/public-routes.ts so the public
// share endpoint is registered outside the authenticated route prefix tree.
export async function registerPublicShareRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { slug: string }; Querystring: { password?: string } }>(
    "/s/:slug",
    { config: { rateLimit: { max: Number(process.env.PUBLIC_SHARE_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const slug = request.params.slug;
      const password = typeof request.query?.password === "string" && request.query.password ? request.query.password : null;
      const result = await readPublicShare(slug, password);
      if (result.status === "not_found") return notFound(reply, "Share not found.");
      if (result.status === "password_required") return reply.code(401).send({ error: "password_required" });
      if (result.status === "wrong_password") return reply.code(403).send({ error: "wrong_password" });
      reply.header("x-pageden-share-indexing", result.share.allowIndexing ? "allow" : "deny");
      // Indexing opt-in mirrors Docmost's search_indexing flag.
      reply.header("x-robots-tag", result.share.allowIndexing ? "all" : "noindex, nofollow");
      return {
        title: result.title,
        path: result.path,
        content: result.content,
        share: { slug: result.share.slug, allowIndexing: result.share.allowIndexing, expiresAt: result.share.expiresAt },
      };
    },
  );
}
