import type { FastifyInstance } from "fastify";
import { AttachmentStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { verifyUploadGrant } from "./upload-grant.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole } from "../permissions/index.js";
import { readBlob, readContent, writeBlob, sweepOrphanObjects } from "../storage.js";

// Attachments belong to a document; access is governed entirely by the parent document's
// permission (read to download/list, editor to upload/delete). Existence is hidden: a user
// who cannot read the document gets 404, not 403, so attachment ids don't leak.

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILENAME_LEN = 255;

export const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
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
    status: "ready" as const,
    createdAt: a.createdAt.toISOString(),
  };
}

/** Thrown by createDocumentAttachment; carries the HTTP-equivalent status. */
export class AttachmentError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/**
 * Validate + persist an attachment for a document.
 * Shared by the REST upload route and the MCP attach-file tool. Throws
 * AttachmentError(status, message) on validation/permission failures. Caller
 * supplies already-read bytes (REST: raw body; MCP: decoded base64).
 */
export async function createDocumentAttachment(opts: {
  documentId: string;
  userId: string;
  filename: string;
  contentType: string;
  body: Buffer;
  ip?: string;
  userAgent?: string;
}): Promise<{ attachment: ReturnType<typeof attachmentDto>; workspaceId: string }> {
  const role = await resolveDocumentRole(opts.userId, opts.documentId);
  if (role === null) throw new AttachmentError(404, "Document not found.");
  if (!atLeast(role, "editor")) throw new AttachmentError(403, "Editor access is required to attach files.");

  const filename = sanitizeFilename(opts.filename);
  if (!filename) throw new AttachmentError(400, "A filename is required.");

  if (!Buffer.isBuffer(opts.body) || opts.body.length === 0) {
    throw new AttachmentError(400, "Attachment body must be non-empty binary content.");
  }
  if (opts.body.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(413, `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes.`);
  }

  const contentType = opts.contentType.split(";")[0]?.trim() || "application/octet-stream";
  if (!ALLOWED_MIME_TYPES.has(contentType)) {
    throw new AttachmentError(415, `Content type "${contentType}" is not allowed.`);
  }

  const doc = await prisma.document.findUniqueOrThrow({
    where: { id: opts.documentId },
    select: { workspaceId: true },
  });
  const { storageKey, hex, size } = await writeBlob(opts.body, doc.workspaceId);

  const attachment = await prisma.attachment.create({
    data: {
      workspaceId: doc.workspaceId,
      documentId: opts.documentId,
      filename,
      contentType,
      size,
      sha256: hex,
      storageKey,
      uploadedById: opts.userId,
      status: AttachmentStatus.READY,
    },
  });
  await writeAuditEvent({
    workspaceId: doc.workspaceId,
    userId: opts.userId,
    action: "attachment_uploaded",
    targetType: "attachment",
    targetId: attachment.id,
    ipAddress: opts.ip,
    userAgent: opts.userAgent,
    metadata: { documentId: opts.documentId, filename, size },
  });
  return { attachment: attachmentDto(attachment), workspaceId: doc.workspaceId };
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
  // Returns 202 Accepted with status "ready".
    instance.post<{ Params: { id: string }; Querystring: { filename?: string } }>(
    "/api/documents/:id/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES + 1024 },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "attachments");

      const headerName = request.headers["x-filename"];
      const rawName = request.query.filename ?? (typeof headerName === "string" ? headerName : "");
      const ctHeader = request.headers["content-type"];
      const userAgent = request.headers["user-agent"];
      const body = request.body;

      try {
        const { attachment } = await createDocumentAttachment({
          documentId: request.params.id,
          userId: auth.userId,
          filename: rawName,
          contentType: typeof ctHeader === "string" ? ctHeader : "",
          body: Buffer.isBuffer(body) ? body : Buffer.alloc(0),
          ip: request.ip,
          userAgent: typeof userAgent === "string" ? userAgent : undefined,
        });
        return reply.code(202).send(attachment);
      } catch (error) {
        if (error instanceof AttachmentError) {
          if (error.status === 404) return notFound(reply, error.message);
          if (error.status === 403) return forbidden(reply);
          if (error.status === 400) return validationError(reply, { file: error.message });
          if (error.status === 413) return reply.code(413).send({ error: "payload_too_large", message: error.message });
          if (error.status === 415) return reply.code(415).send({ error: "unsupported_media_type", message: error.message });
        }
        throw error;
      }
    },
  );

    // Pre-signed binary upload: authorized by a short-lived grant (from the MCP
    // request-attachment-upload tool), not by an ambient session/bearer — so an
    // agent can PUT the raw file to 50 MB without base64. CSRF-exempt by path.
    instance.put<{ Querystring: { grant?: string } }>(
    "/api/attachments/upload",
    { bodyLimit: MAX_ATTACHMENT_BYTES + 1024 },
    async (request, reply) => {
      const grant = verifyUploadGrant(request.query.grant);
      if (!grant) return reply.code(403).send({ error: "forbidden", message: "Invalid or expired upload grant." });
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return validationError(reply, { file: "Upload body must be non-empty binary content." });
      }
      if (body.length > grant.maxBytes) {
        return reply.code(413).send({ error: "payload_too_large", message: `Upload exceeds ${grant.maxBytes} bytes.` });
      }
      const userAgent = request.headers["user-agent"];
      try {
        const { attachment } = await createDocumentAttachment({
          documentId: grant.documentId,
          userId: grant.userId,
          filename: grant.filename,
          contentType: grant.contentType,
          body,
          ip: request.ip,
          userAgent: typeof userAgent === "string" ? userAgent : undefined,
        });
        return reply.code(202).send(attachment);
      } catch (error) {
        if (error instanceof AttachmentError) {
          if (error.status === 404) return notFound(reply, error.message);
          if (error.status === 403) return forbidden(reply);
          if (error.status === 400) return validationError(reply, { file: error.message });
          if (error.status === 413) return reply.code(413).send({ error: "payload_too_large", message: error.message });
          if (error.status === 415) return reply.code(415).send({ error: "unsupported_media_type", message: error.message });
        }
        throw error;
      }
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
    instance.get<{ Params: { attachmentId: string } }>("/api/attachments/:attachmentId", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "attachments");
    const attachment = await prisma.attachment.findFirst({
      where: { id: request.params.attachmentId, deletedAt: null },
    });
    if (!attachment) return notFound(reply, "Attachment not found.");
    const role = await resolveDocumentRole(auth.userId, attachment.documentId);
    if (role === null) return notFound(reply, "Attachment not found."); // hide existence
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

    const doc = await prisma.document.findUnique({
      where: { id: attachment.documentId },
      select: { currentVersionId: true },
    });
    if (doc?.currentVersionId) {
      const revision = await prisma.documentRevision.findUnique({
        where: { id: doc.currentVersionId },
        select: { storageKey: true },
      });
      if (revision) {
        const content = await readContent(revision.storageKey);
        const relativeUrl = `/api/attachments/${attachment.id}`;
        const encodedUrl = encodeURI(relativeUrl);
        if (content.includes(relativeUrl) || content.includes(encodedUrl)) {
          return reply.code(409).send({
            error: "attachment_linked",
            message: "This attachment is still linked in the document. Remove the link first, then delete.",
          });
        }
      }
    }

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

  // Schedule a daily orphan object sweep so deleted attachment bytes don't accumulate.
  const sweepInterval = setInterval(
    () => void sweepOrphanObjects().catch((err) => console.error("[storage] orphan sweep failed:", err)),
    24 * 60 * 60 * 1000,
  );
  sweepInterval.unref();
  app.addHook("onClose", async () => clearInterval(sweepInterval));
}
