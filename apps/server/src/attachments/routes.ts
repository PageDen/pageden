import type { FastifyInstance } from "fastify";
import { AttachmentStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole } from "../permissions/index.js";
import { readBlob, writeBlob, sweepOrphanObjects } from "../storage.js";
import { kickScanWorker, recoverStuckScanJobs } from "./scanner.js";
import { canManageWorkspace } from "../permissions/index.js";

// Attachments belong to a document; access is governed entirely by the parent document's
// permission (read to download/list, editor to upload/delete). Existence is hidden: a user
// who cannot read the document gets 404, not 403, so attachment ids don't leak.

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILENAME_LEN = 255;

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// Strip directory components, control characters, and bidi/format overrides so the stored and
// served name is a safe single path segment (defends Content-Disposition + any later FS use).
function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- intentionally strip control + bidi/format chars
  return base.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, "").trim().slice(0, MAX_FILENAME_LEN);
}

function attachmentDto(a: {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  status: AttachmentStatus;
  createdAt: Date;
}) {
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    sha256: a.sha256,
    status: a.status.toLowerCase() as "scanning" | "ready" | "quarantined",
    createdAt: a.createdAt.toISOString(),
  };
}

export async function registerAttachmentRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulate the raw-body parser inside this plugin scope so it only affects attachment
  // routes; every other route keeps Fastify's JSON-only parsing and the default body limit.
  await app.register(async (instance) => {
    instance.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

  // Upload an attachment to a document. Raw bytes in the body; filename via ?filename= (or the
  // x-filename header); content type from the Content-Type header.
  // Returns 202 Accepted with status "scanning". Scan worker promotes to "ready" or "quarantined".
    instance.post<{ Params: { id: string }; Querystring: { filename?: string } }>(
    "/api/documents/:id/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES + 1024 },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "attachments");
      const role = await resolveDocumentRole(auth.userId, request.params.id);
      if (role === null) return notFound(reply, "Document not found.");
      if (!atLeast(role, "editor")) return forbidden(reply);

      // request.query.filename is already percent-decoded once by the query parser; the header is
      // treated as literal text. No extra decodeURIComponent (it can throw and double-decode).
      const headerName = request.headers["x-filename"];
      const rawName = request.query.filename ?? (typeof headerName === "string" ? headerName : "");
      const filename = sanitizeFilename(rawName);
      if (!filename) return validationError(reply, { filename: "A filename is required." });

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return validationError(reply, { file: "Attachment body must be non-empty binary content." });
      }
      if (body.length > MAX_ATTACHMENT_BYTES) {
        return reply
          .code(413)
          .send({ error: "payload_too_large", message: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes.` });
      }

      const ctHeader = request.headers["content-type"];
      const contentType =
        (typeof ctHeader === "string" && ctHeader.split(";")[0]?.trim()) || "application/octet-stream";

      if (!ALLOWED_MIME_TYPES.has(contentType)) {
        return reply
          .code(415)
          .send({ error: "unsupported_media_type", message: `Content type "${contentType}" is not allowed.` });
      }

      const doc = await prisma.document.findUniqueOrThrow({
        where: { id: request.params.id },
        select: { workspaceId: true },
      });
      const { storageKey, hex, size } = await writeBlob(body, doc.workspaceId);

      const attachment = await prisma.attachment.create({
        data: {
          workspaceId: doc.workspaceId,
          documentId: request.params.id,
          filename,
          contentType,
          size,
          sha256: hex,
          storageKey,
          uploadedById: auth.userId,
          status: AttachmentStatus.SCANNING,
        },
      });
      kickScanWorker();
      await writeAuditEvent({
        workspaceId: doc.workspaceId,
        userId: auth.userId,
        action: "attachment_uploaded",
        targetType: "attachment",
        targetId: attachment.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        metadata: { documentId: request.params.id, filename, size },
      });
      return reply.code(202).send(attachmentDto(attachment));
    },
  );

  // List a document's attachments.
    instance.get<{ Params: { id: string } }>("/api/documents/:id/attachments", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "attachments");
    const role = await resolveDocumentRole(auth.userId, request.params.id);
    if (role === null) return notFound(reply, "Document not found.");
    const attachments = await prisma.attachment.findMany({
      where: { documentId: request.params.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return { attachments: attachments.map(attachmentDto) };
  });

  // Metadata polling endpoint: returns JSON status for a single attachment without streaming bytes.
  // Registered before the download route so Fastify sees the more-specific path first.
    instance.get<{ Params: { attachmentId: string } }>("/api/attachments/:attachmentId/meta", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "attachments");
    const attachment = await prisma.attachment.findFirst({
      where: { id: request.params.attachmentId, deletedAt: null },
    });
    if (!attachment) return notFound(reply, "Attachment not found.");
    const role = await resolveDocumentRole(auth.userId, attachment.documentId);
    if (role === null) return notFound(reply, "Attachment not found."); // hide existence
    return attachmentDto(attachment);
  });

  // Download an attachment's bytes (read on the parent document required).
  // QUARANTINED attachments are not downloadable.
    instance.get<{ Params: { attachmentId: string } }>("/api/attachments/:attachmentId", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "attachments");
    const attachment = await prisma.attachment.findFirst({
      where: { id: request.params.attachmentId, deletedAt: null },
    });
    if (!attachment) return notFound(reply, "Attachment not found.");
    const role = await resolveDocumentRole(auth.userId, attachment.documentId);
    if (role === null) return notFound(reply, "Attachment not found."); // hide existence
    if (attachment.status === AttachmentStatus.SCANNING) {
      return reply.code(503).header("retry-after", "5").send({ error: "scan_pending", message: "Attachment is being scanned. Try again shortly." });
    }
    if (attachment.status === AttachmentStatus.QUARANTINED) return forbidden(reply);
    const bytes = await readBlob(attachment.storageKey);
    return reply
      .header("content-type", attachment.contentType)
      .header("content-length", String(attachment.size))
      .header("etag", `"${attachment.sha256}"`)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`)
      .send(bytes);
  });

  // Soft-delete an attachment (editor on the parent document required).
    instance.delete<{ Params: { attachmentId: string } }>("/api/attachments/:attachmentId", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "attachments");
    const attachment = await prisma.attachment.findFirst({
      where: { id: request.params.attachmentId, deletedAt: null },
    });
    if (!attachment) return notFound(reply, "Attachment not found.");
    const role = await resolveDocumentRole(auth.userId, attachment.documentId);
    if (role === null) return notFound(reply, "Attachment not found."); // hide existence
    if (!atLeast(role, "editor")) return forbidden(reply);
    await prisma.attachment.update({ where: { id: attachment.id }, data: { deletedAt: new Date() } });
    await writeAuditEvent({
      workspaceId: attachment.workspaceId,
      userId: auth.userId,
      action: "attachment_deleted",
      targetType: "attachment",
      targetId: attachment.id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      metadata: { documentId: attachment.documentId },
    });
    return { ok: true };
  });
  });

  // Admin: list quarantined attachments for a workspace.
  app.get<{ Params: { workspaceId: string }; Querystring: { cursor?: string } }>(
    "/api/workspaces/:workspaceId/attachments/quarantined",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      if (!(await canManageWorkspace(auth.userId, request.params.workspaceId))) return forbidden(reply);
      const limit = 50;
      const cursor = request.query.cursor ? new Date(request.query.cursor) : undefined;
      const rows = await prisma.attachment.findMany({
        where: {
          workspaceId: request.params.workspaceId,
          status: AttachmentStatus.QUARANTINED,
          deletedAt: null,
          ...(cursor ? { createdAt: { lt: cursor } } : {}),
        },
        include: {
          document: { select: { title: true } },
          uploadedBy: { select: { email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        attachments: page.map((a) => ({
          ...attachmentDto(a),
          documentId: a.documentId,
          documentTitle: a.document.title,
          uploadedByEmail: a.uploadedBy.email,
        })),
        next: hasMore ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null,
      };
    },
  );

  // Admin: release a quarantined attachment back to SCANNING so it is re-scanned.
  app.post<{ Params: { attachmentId: string } }>(
    "/api/attachments/:attachmentId/unquarantine",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const attachment = await prisma.attachment.findFirst({
        where: { id: request.params.attachmentId, status: AttachmentStatus.QUARANTINED, deletedAt: null },
        select: { id: true, workspaceId: true },
      });
      if (!attachment) return notFound(reply, "Attachment not found.");
      if (!(await canManageWorkspace(auth.userId, attachment.workspaceId))) return forbidden(reply);
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: { status: AttachmentStatus.SCANNING },
      });
      kickScanWorker();
      return { ok: true };
    },
  );

  // Boot: kick the scan worker so any attachments stuck in SCANNING from a prior crash get processed.
  recoverStuckScanJobs();

  // Schedule a daily orphan object sweep so quarantined/deleted attachment bytes don't accumulate.
  const sweepInterval = setInterval(
    () => void sweepOrphanObjects().catch((err) => console.error("[storage] orphan sweep failed:", err)),
    24 * 60 * 60 * 1000,
  );
  sweepInterval.unref();
  app.addHook("onClose", async () => clearInterval(sweepInterval));
}
