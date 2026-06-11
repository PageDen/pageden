import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole } from "../permissions/index.js";
import { readBlob, writeBlob } from "../storage.js";

// Attachments belong to a document; access is governed entirely by the parent document's
// permission (read to download/list, editor to upload/delete). Existence is hidden: a user
// who cannot read the document gets 404, not 403, so attachment ids don't leak.

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MiB
const MAX_FILENAME_LEN = 255;

// Strip directory components, control characters, and bidi/format overrides so the stored and
// served name is a safe single path segment (defends Content-Disposition + any later FS use).
function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- intentionally strip control + bidi/format chars
  return base.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, MAX_FILENAME_LEN);
}

function attachmentDto(a: {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: Date;
}) {
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    sha256: a.sha256,
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

      const { storageKey, hex, size } = await writeBlob(body);

      const doc = await prisma.document.findUniqueOrThrow({
        where: { id: request.params.id },
        select: { workspaceId: true },
      });
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
        },
      });
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
      return reply.code(201).send(attachmentDto(attachment));
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
}
