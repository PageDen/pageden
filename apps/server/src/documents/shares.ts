import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { AttachmentStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole, resolveFolderRole } from "../permissions/index.js";
import { hashPassword, verifyPassword } from "../passwords.js";
import { readBlob, readContent } from "../storage.js";

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
  documentId: string | null;
  folderId: string | null;
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
  const base = {
    id: row.id,
    workspaceId: row.workspaceId,
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
  if (row.documentId) return { ...base, targetType: "document" as const, documentId: row.documentId };
  return { ...base, targetType: "folder" as const, folderId: row.folderId ?? "" };
}

export async function createShare(
  auth: AuthContext,
  documentId: string,
  opts: { ttlDays?: number; password?: string | null; allowIndexing?: boolean },
): Promise<{ status: "ok"; share: ReturnType<typeof shareDto> } | { status: "not_found" } | { status: "forbidden" } | { status: "validation"; field: string; message: string }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true, workspace: { select: { publicSharingEnabled: true } } },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  if (!doc.workspace.publicSharingEnabled) return { status: "forbidden" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };
  if (!atLeast(role, "manager")) return { status: "forbidden" };

  const password = typeof opts.password === "string" ? opts.password.trim() : "";
  if (password && password.length > MAX_NOTE_PASSWORD) {
    return { status: "validation", field: "password", message: `password must be ${MAX_NOTE_PASSWORD} characters or fewer.` };
  }
  // Argon2id for shared-link passwords: users may pick low-entropy values, so
  // we need slow/memory-hard hashing to make offline brute-force impractical
  // (CodeQL js/insufficient-password-hash). Token lookups elsewhere stay on
  // HMAC because they're high-entropy server-issued strings.
  const passwordHash = password ? await hashPassword(password) : null;
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

export async function createFolderShare(
  auth: AuthContext,
  folderId: string,
  opts: { ttlDays?: number; password?: string | null; allowIndexing?: boolean },
): Promise<{ status: "ok"; share: ReturnType<typeof shareDto> } | { status: "not_found" } | { status: "forbidden" } | { status: "validation"; field: string; message: string }> {
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, deletedAt: null },
    select: { id: true, workspaceId: true, workspace: { select: { publicSharingEnabled: true } } },
  });
  if (!folder) return { status: "not_found" };
  if (auth.tokenWorkspaceId && folder.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  if (!folder.workspace.publicSharingEnabled) return { status: "forbidden" };
  const role = await resolveFolderRole(auth.userId, folder.id);
  if (!role) return { status: "not_found" };
  if (!atLeast(role, "manager")) return { status: "forbidden" };

  const password = typeof opts.password === "string" ? opts.password.trim() : "";
  if (password && password.length > MAX_NOTE_PASSWORD) {
    return { status: "validation", field: "password", message: `password must be ${MAX_NOTE_PASSWORD} characters or fewer.` };
  }
  const passwordHash = password ? await hashPassword(password) : null;
  const expiresAt = parseTtl(opts.ttlDays);

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
      workspaceId: folder.workspaceId,
      folderId: folder.id,
      slug,
      passwordHash,
      allowIndexing: opts.allowIndexing === true,
      expiresAt,
      createdById: auth.userId,
    },
  });
  await writeAuditEvent({
    workspaceId: folder.workspaceId,
    userId: auth.userId,
    action: auth.tokenKind === "agent" ? "folder_shared_by_agent" : "folder_shared",
    targetType: "document_share",
    targetId: row.id,
    metadata: { folderId: folder.id, expiresAt: expiresAt?.toISOString() ?? null, hasPassword: passwordHash !== null, allowIndexing: row.allowIndexing },
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
  const role = share.documentId
    ? await resolveDocumentRole(auth.userId, share.documentId)
    : share.folderId
      ? await resolveFolderRole(auth.userId, share.folderId)
      : null;
  if (!role) return { status: "not_found" };
  const isAuthor = share.createdById === auth.userId;
  if (!isAuthor && !atLeast(role, "manager")) return { status: "forbidden" };
  if (share.revokedAt) return { status: "ok", share: shareDto(share) };

  const updated = await prisma.documentShare.update({
    where: { id: share.id },
    data: { revokedAt: new Date() },
  });
  let revokeAction = auth.tokenKind === "agent" ? "document_share_revoked_by_agent" : "document_share_revoked";
  if (share.folderId) {
    revokeAction = auth.tokenKind === "agent" ? "folder_share_revoked_by_agent" : "folder_share_revoked";
  }
  await writeAuditEvent({
    workspaceId: share.workspaceId,
    userId: auth.userId,
    action: revokeAction,
    targetType: "document_share",
    targetId: share.id,
    metadata: { documentId: share.documentId, folderId: share.folderId },
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
    const role = row.documentId
      ? await resolveDocumentRole(auth.userId, row.documentId)
      : row.folderId
        ? await resolveFolderRole(auth.userId, row.folderId)
        : null;
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

type ValidShareResult =
  | { status: "ok"; share: ShareRow }
  | { status: "password_required" }
  | { status: "wrong_password" }
  | { status: "not_found" };

type ManualDocRow = {
  id: string;
  title: string;
  slug: string;
  path: string;
  folder: { path: string };
  currentVersionId: string | null;
};

async function resolveValidShare(slug: string, password: string | null): Promise<ValidShareResult> {
  const share = await prisma.documentShare.findUnique({ where: { slug } });
  if (!share) return { status: "not_found" };
  if (share.revokedAt) return { status: "not_found" };
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) return { status: "not_found" };
  const workspace = await prisma.workspace.findUnique({
    where: { id: share.workspaceId },
    select: { publicSharingEnabled: true },
  });
  if (!workspace?.publicSharingEnabled) return { status: "not_found" };
  if (share.passwordHash) {
    if (!password) return { status: "password_required" };
    const ok = await verifyPassword(share.passwordHash, password);
    if (!ok) return { status: "wrong_password" };
  }
  return { status: "ok", share };
}

function publicAttachmentUrl(slug: string, attachmentId: string): string {
  return `/api/public/shares/${encodeURIComponent(slug)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function rewriteAttachmentUrls(content: string, slug: string): string {
  return content.replace(/\/api\/attachments\/([A-Za-z0-9_-]+)/g, (_match, id: string) => publicAttachmentUrl(slug, id));
}

async function currentDocumentContent(currentVersionId: string | null, slug: string): Promise<string> {
  if (!currentVersionId) return "";
  const revision = await prisma.documentRevision.findUnique({
    where: { id: currentVersionId },
    select: { storageKey: true },
  });
  if (!revision) return "";
  return rewriteAttachmentUrls(await readContent(revision.storageKey), slug);
}

function isDescendantPath(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function docDepth(doc: ManualDocRow, rootPath: string): number {
  const folderPath = doc.folder.path;
  if (folderPath === rootPath) return 0;
  const relative = folderPath.slice(rootPath.length + 1);
  return relative ? relative.split("/").length : 0;
}

function chooseLanding(docs: ManualDocRow[]): ManualDocRow | null {
  return docs.find((doc) => ["index", "readme"].includes(doc.slug.toLowerCase())) ?? docs[0] ?? null;
}

async function manualDocs(share: ShareRow): Promise<{ root: { id: string; name: string; path: string }; docs: ManualDocRow[] } | null> {
  if (!share.folderId) return null;
  const root = await prisma.folder.findFirst({
    where: { id: share.folderId, deletedAt: null },
    select: { id: true, name: true, path: true },
  });
  if (!root) return null;
  const docs = await prisma.document.findMany({
    where: {
      workspaceId: share.workspaceId,
      deletedAt: null,
      status: "canonical",
      folder: { deletedAt: null, path: { startsWith: root.path } },
    },
    select: { id: true, title: true, slug: true, path: true, currentVersionId: true, folder: { select: { path: true } } },
    orderBy: { path: "asc" },
  });
  return { root, docs: docs.filter((doc) => isDescendantPath(doc.folder.path, root.path)) };
}

export type PublicShareViewResult =
  | { status: "ok"; body: unknown; allowIndexing: boolean }
  | { status: "password_required" }
  | { status: "wrong_password" }
  | { status: "not_found" };

export async function readPublicShareView(slug: string, password: string | null): Promise<PublicShareViewResult> {
  const valid = await resolveValidShare(slug, password);
  if (valid.status !== "ok") return valid;
  const { share } = valid;
  if (share.documentId) {
    const doc = await prisma.document.findFirst({
      where: { id: share.documentId, deletedAt: null, status: "canonical" },
      select: { id: true, title: true, path: true, currentVersionId: true },
    });
    if (!doc) return { status: "not_found" };
    return {
      status: "ok",
      allowIndexing: share.allowIndexing,
      body: {
        type: "document",
        title: doc.title,
        path: doc.path,
        content: await currentDocumentContent(doc.currentVersionId, share.slug),
        allowIndexing: share.allowIndexing,
        share: { slug: share.slug, expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null },
      },
    };
  }

  const manual = await manualDocs(share);
  if (!manual) return { status: "not_found" };
  const landing = chooseLanding(manual.docs);
  return {
    status: "ok",
    allowIndexing: share.allowIndexing,
    body: {
      type: "manual",
      title: manual.root.name,
      allowIndexing: share.allowIndexing,
      nav: manual.docs.map((doc) => ({
        docId: doc.id,
        title: doc.title,
        href: `/s/${share.slug}/p/${doc.id}`,
        depth: docDepth(doc, manual.root.path),
      })),
      landing: landing
        ? { docId: landing.id, title: landing.title, content: await currentDocumentContent(landing.currentVersionId, share.slug) }
        : null,
      share: { slug: share.slug, expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null },
    },
  };
}

export async function readPublicManualPage(
  slug: string,
  password: string | null,
  docId: string | undefined,
): Promise<PublicShareViewResult> {
  if (!docId) return { status: "not_found" };
  const valid = await resolveValidShare(slug, password);
  if (valid.status !== "ok") return valid;
  const { share } = valid;
  if (!share.folderId) return { status: "not_found" };
  const manual = await manualDocs(share);
  if (!manual) return { status: "not_found" };
  const doc = manual.docs.find((candidate) => candidate.id === docId);
  if (!doc) return { status: "not_found" };
  return {
    status: "ok",
    allowIndexing: share.allowIndexing,
    body: {
      docId: doc.id,
      title: doc.title,
      content: await currentDocumentContent(doc.currentVersionId, share.slug),
      breadcrumb: [{ docId: doc.id, title: doc.title }],
    },
  };
}

export async function readPublicShareAttachment(
  slug: string,
  password: string | null,
  attachmentId: string,
): Promise<
  | { status: "ok"; bytes: Buffer; contentType: string; size: number; sha256: string; filename: string; allowIndexing: boolean }
  | { status: "password_required" }
  | { status: "wrong_password" }
  | { status: "not_found" }
> {
  const valid = await resolveValidShare(slug, password);
  if (valid.status !== "ok") return valid;
  const { share } = valid;
  const attachment = await prisma.attachment.findFirst({
    where: {
      id: attachmentId,
      workspaceId: share.workspaceId,
      deletedAt: null,
      status: AttachmentStatus.READY,
    },
    select: {
      id: true,
      documentId: true,
      filename: true,
      contentType: true,
      size: true,
      sha256: true,
      storageKey: true,
      document: { select: { id: true, deletedAt: true, status: true, folder: { select: { path: true, deletedAt: true } } } },
    },
  });
  if (!attachment || attachment.document.deletedAt || attachment.document.status !== "canonical" || attachment.document.folder.deletedAt) {
    return { status: "not_found" };
  }
  if (share.documentId) {
    if (attachment.documentId !== share.documentId) return { status: "not_found" };
  } else if (share.folderId) {
    const root = await prisma.folder.findFirst({ where: { id: share.folderId, deletedAt: null }, select: { path: true } });
    if (!root || !isDescendantPath(attachment.document.folder.path, root.path)) return { status: "not_found" };
  } else {
    return { status: "not_found" };
  }
  return {
    status: "ok",
    bytes: await readBlob(attachment.storageKey),
    contentType: attachment.contentType,
    size: attachment.size,
    sha256: attachment.sha256,
    filename: attachment.filename,
    allowIndexing: share.allowIndexing,
  };
}

export async function readPublicShare(slug: string, password: string | null): Promise<PublicShareResult> {
  const valid = await resolveValidShare(slug, password);
  if (valid.status !== "ok") return valid;
  const { share } = valid;
  if (!share.documentId) return { status: "not_found" };
  const doc = await prisma.document.findFirst({
    where: { id: share.documentId, deletedAt: null, status: "canonical" },
    select: { id: true, title: true, path: true, currentVersionId: true },
  });
  if (!doc) return { status: "not_found" };
  const content = await currentDocumentContent(doc.currentVersionId, share.slug);
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

  app.post<{ Params: { id: string }; Body: { ttlDays?: number; password?: string | null; allowIndexing?: boolean } }>(
    "/api/folders/:id/share",
    { config: { rateLimit: { max: Number(process.env.SHARE_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const result = await createFolderShare(auth, request.params.id, {
        ttlDays: request.body?.ttlDays,
        password: request.body?.password ?? null,
        allowIndexing: request.body?.allowIndexing ?? false,
      });
      if (result.status === "not_found") return notFound(reply, "Folder not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "validation") return validationError(reply, { [result.field]: result.message });
      return reply.code(201).send({ share: result.share });
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
  function setIndexingHeaders(reply: FastifyReply, allowIndexing: boolean) {
    reply.header("x-pageden-share-indexing", allowIndexing ? "allow" : "deny");
    reply.header("x-robots-tag", allowIndexing ? "all" : "noindex, nofollow");
  }

  function publicError(result: { status: "password_required" | "wrong_password" | "not_found" }, reply: FastifyReply) {
    if (result.status === "password_required") return reply.code(401).send({ error: "password_required" });
    if (result.status === "wrong_password") return reply.code(403).send({ error: "wrong_password" });
    return reply.code(404).send({ error: "not_found", message: "Share not found." });
  }

  app.get<{ Params: { slug: string }; Querystring: { password?: string } }>(
    "/api/public/shares/:slug",
    { config: { rateLimit: { max: Number(process.env.PUBLIC_SHARE_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const password = typeof request.query?.password === "string" && request.query.password ? request.query.password : null;
      const result = await readPublicShareView(request.params.slug, password);
      if (result.status !== "ok") return publicError(result, reply);
      setIndexingHeaders(reply, result.allowIndexing);
      return result.body;
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { docId?: string; password?: string } }>(
    "/api/public/shares/:slug/page",
    { config: { rateLimit: { max: Number(process.env.PUBLIC_SHARE_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const password = typeof request.query?.password === "string" && request.query.password ? request.query.password : null;
      const result = await readPublicManualPage(request.params.slug, password, request.query.docId);
      if (result.status !== "ok") return publicError(result, reply);
      setIndexingHeaders(reply, result.allowIndexing);
      return result.body;
    },
  );

  app.get<{ Params: { slug: string; attachmentId: string }; Querystring: { password?: string } }>(
    "/api/public/shares/:slug/attachments/:attachmentId",
    { config: { rateLimit: { max: Number(process.env.PUBLIC_SHARE_RATE_LIMIT_MAX ?? 120), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const password = typeof request.query?.password === "string" && request.query.password ? request.query.password : null;
      const result = await readPublicShareAttachment(request.params.slug, password, request.params.attachmentId);
      if (result.status !== "ok") return publicError(result, reply);
      setIndexingHeaders(reply, result.allowIndexing);
      return reply
        .header("content-type", result.contentType)
        .header("content-length", String(result.size))
        .header("etag", `"${result.sha256}"`)
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
        .send(result.bytes);
    },
  );

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
