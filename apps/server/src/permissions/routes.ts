import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import type { PermissionResourceType, PermissionRole, PermissionSubjectType, Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, authorizeDocumentRole, authorizeFolderRole, resolveDocumentRole, resolveFolderRole } from "./index.js";

const ROLES: PermissionRole[] = ["viewer", "editor", "manager"];
const SUBJECT_TYPES: PermissionSubjectType[] = ["user", "group"];
type ReplacePermissionsOutcome =
  | { ok: true; version: string }
  | { ok: false; status: "not_found" | "forbidden" }
  | { ok: false; status: "conflict"; currentVersion: string };

// Reject subjects that do not belong to the target workspace (BLOCKER 2): a user must be a
// workspace member and a group must belong to the workspace.
async function invalidSubject(
  workspaceId: string,
  rows: Array<{ subjectType: PermissionSubjectType; subjectId: string }>,
): Promise<string | null> {
  for (const row of rows) {
    if (row.subjectType === "user") {
      const membership = await prisma.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: row.subjectId } },
        select: { id: true },
      });
      if (!membership) return "Each user must be a member of this workspace.";
    } else {
      const group = await prisma.group.findFirst({
        where: { id: row.subjectId, workspaceId },
        select: { id: true },
      });
      if (!group) return "Each group must belong to this workspace.";
    }
  }
  return null;
}

interface PermissionInput {
  subjectType?: string;
  subjectId?: string;
  role?: string;
}

function validatePermissions(input: unknown): { ok: true; value: Array<{ subjectType: PermissionSubjectType; subjectId: string; role: PermissionRole }>; version: string | null } | { ok: false; message: string } {
  if (!input || typeof input !== "object" || !Array.isArray((input as { permissions?: unknown }).permissions)) {
    return { ok: false, message: "permissions must be an array." };
  }
  const version = (input as { version?: unknown }).version;
  if (version !== undefined && typeof version !== "string") return { ok: false, message: "version must be a string." };
  const rows = (input as { permissions: PermissionInput[] }).permissions;
  const bySubject = new Map<string, { subjectType: PermissionSubjectType; subjectId: string; role: PermissionRole }>();
  for (const row of rows) {
    if (!SUBJECT_TYPES.includes(row.subjectType as PermissionSubjectType)) return { ok: false, message: "subjectType must be 'user' or 'group'." };
    if (!row.subjectId) return { ok: false, message: "subjectId is required." };
    if (!ROLES.includes(row.role as PermissionRole)) return { ok: false, message: "role must be viewer, editor, or manager." };
    // Dedupe (last wins) so a single request cannot trip the permission unique index.
    bySubject.set(`${row.subjectType}:${row.subjectId}`, {
      subjectType: row.subjectType as PermissionSubjectType,
      subjectId: row.subjectId,
      role: row.role as PermissionRole,
    });
  }
  return { ok: true, value: [...bySubject.values()], version: version ?? null };
}

function permissionVersion(
  permissions: Array<{ subjectType: PermissionSubjectType; subjectId: string; role: PermissionRole }>,
): string {
  const canonical = [...permissions]
    .sort((a, b) => `${a.subjectType}:${a.subjectId}`.localeCompare(`${b.subjectType}:${b.subjectId}`))
    .map((p) => `${p.subjectType}:${p.subjectId}:${p.role}`)
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

async function currentPermissionRows(
  client: Prisma.TransactionClient | typeof prisma,
  workspaceId: string,
  resourceType: PermissionResourceType,
  resourceId: string,
) {
  return client.permission.findMany({
    where: { workspaceId, resourceType, resourceId },
    orderBy: [{ subjectType: "asc" }, { subjectId: "asc" }],
  });
}

async function listPermissions(reply: FastifyReply, workspaceId: string, resourceType: PermissionResourceType, resourceId: string) {
  const permissions = await currentPermissionRows(prisma, workspaceId, resourceType, resourceId);
  return reply.send({
    version: permissionVersion(permissions),
    permissions: permissions.map((permission) => ({
      id: permission.id,
      subjectType: permission.subjectType,
      subjectId: permission.subjectId,
      role: permission.role,
    })),
  });
}

async function replacePermissions(
  workspaceId: string,
  resourceType: PermissionResourceType,
  resourceId: string,
  rows: Array<{ subjectType: PermissionSubjectType; subjectId: string; role: PermissionRole }>,
  baseVersion: string | null,
  userId: string,
): Promise<ReplacePermissionsOutcome> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<ReplacePermissionsOutcome> => {
    // Re-verify manage permission under the transaction so a concurrent revoke is honored.
    const az =
      resourceType === "document"
        ? await authorizeDocumentRole(userId, resourceId, "manager", tx)
        : await authorizeFolderRole(userId, resourceId, "manager", tx);
    if (!az.ok) return az;
    const current = await currentPermissionRows(tx, workspaceId, resourceType, resourceId);
    const currentVersion = permissionVersion(current);
    if (baseVersion && baseVersion !== currentVersion) {
      return { ok: false, status: "conflict", currentVersion };
    }
    await tx.permission.deleteMany({ where: { workspaceId, resourceType, resourceId } });
    if (rows.length > 0) {
      await tx.permission.createMany({
        data: rows.map((row) => ({ workspaceId, resourceType, resourceId, subjectType: row.subjectType, subjectId: row.subjectId, role: row.role })),
      });
    }
    await writeAuditEvent(
      { workspaceId, userId, action: "permissions_replaced", targetType: resourceType, targetId: resourceId, metadata: { count: rows.length } },
      tx,
    );
    return { ok: true, version: permissionVersion(rows) };
  });
}

export async function registerPermissionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/documents/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true, workspaceId: true } });
    if (!doc) return notFound(reply, "Document not found.");
    const role = await resolveDocumentRole(auth.userId, doc.id);
    if (role === null) return notFound(reply, "Document not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    return listPermissions(reply, doc.workspaceId, "document", doc.id);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/documents/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const doc = await prisma.document.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true, workspaceId: true } });
    if (!doc) return notFound(reply, "Document not found.");
    const role = await resolveDocumentRole(auth.userId, doc.id);
    if (role === null) return notFound(reply, "Document not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    const parsed = validatePermissions(request.body);
    if (!parsed.ok) return validationError(reply, { permissions: parsed.message });
    const subjectError = await invalidSubject(doc.workspaceId, parsed.value);
    if (subjectError) return validationError(reply, { permissions: subjectError });
    const outcome = await replacePermissions(doc.workspaceId, "document", doc.id, parsed.value, parsed.version, auth.userId);
    if (!outcome.ok) {
      if (outcome.status === "not_found") return notFound(reply, "Document not found.");
      if (outcome.status === "conflict") {
        return reply.code(409).send({ error: "conflict", currentVersion: outcome.currentVersion, message: "Permissions changed on the server." });
      }
      return forbidden(reply);
    }
    return { ok: true, version: outcome.version };
  });

  app.get<{ Params: { id: string } }>("/api/folders/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true, workspaceId: true } });
    if (!folder) return notFound(reply, "Folder not found.");
    const role = await resolveFolderRole(auth.userId, folder.id);
    if (role === null) return notFound(reply, "Folder not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    return listPermissions(reply, folder.workspaceId, "folder", folder.id);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/folders/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true, workspaceId: true } });
    if (!folder) return notFound(reply, "Folder not found.");
    const role = await resolveFolderRole(auth.userId, folder.id);
    if (role === null) return notFound(reply, "Folder not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    const parsed = validatePermissions(request.body);
    if (!parsed.ok) return validationError(reply, { permissions: parsed.message });
    const subjectError = await invalidSubject(folder.workspaceId, parsed.value);
    if (subjectError) return validationError(reply, { permissions: subjectError });
    const outcome = await replacePermissions(folder.workspaceId, "folder", folder.id, parsed.value, parsed.version, auth.userId);
    if (!outcome.ok) {
      if (outcome.status === "not_found") return notFound(reply, "Folder not found.");
      if (outcome.status === "conflict") {
        return reply.code(409).send({ error: "conflict", currentVersion: outcome.currentVersion, message: "Permissions changed on the server." });
      }
      return forbidden(reply);
    }
    return { ok: true, version: outcome.version };
  });
}
