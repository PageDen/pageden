import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import type { PermissionResourceType, PermissionRole, Prisma } from "@prisma/client";

// The legacy subjectType column was dropped in the A3 cutover. The API request
// shape still uses subjectType / subjectId so existing clients (and the audit
// log) keep their shape; this local alias replaces the Prisma-generated enum
// that disappeared along with the column.
type PermissionSubjectType = "user" | "group";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { env } from "../env.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { getMailer } from "../mailer.js";
import { atLeast, authorizeDocumentRole, authorizeFolderRole, resolveDocumentRole, resolveFolderRole } from "./index.js";

const ROLES: PermissionRole[] = ["viewer", "editor", "manager"];
const SUBJECT_TYPES: PermissionSubjectType[] = ["user", "group"];
type ReplacePermissionsOutcome =
  | { ok: true; version: string; notifications: PermissionGrantNotification[] }
  | { ok: false; status: "not_found" | "forbidden" }
  | { ok: false; status: "conflict"; currentVersion: string };
type GrantPermissionOutcome =
  | {
      ok: true;
      version: string;
      membershipCreated: boolean;
      permission: { subjectType: "user"; subjectId: string; role: PermissionRole };
      user: { id: string; email: string; name: string };
    }
  | { ok: false; status: "not_found" | "forbidden" | "unknown_user" };

interface PermissionGrantNotification {
  user: { id: string; email: string; name: string };
  role: PermissionRole;
}

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

interface GrantPermissionInput {
  email?: string;
  role?: string;
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  if (value.length > 254 || value.includes(" ") || value.includes("\t") || value.includes("\n")) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length <= 64 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
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

function validateGrant(input: unknown): { ok: true; value: { email: string; role: PermissionRole } } | { ok: false; fields: Record<string, string> } {
  if (!input || typeof input !== "object") {
    return { ok: false, fields: { email: "Email is required.", role: "Role is required." } };
  }
  const row = input as GrantPermissionInput;
  const fields: Record<string, string> = {};
  const email = typeof row.email === "string" ? normaliseEmail(row.email) : "";
  if (!email) fields.email = "Email is required.";
  else if (!isValidEmail(email)) fields.email = "Enter a valid email address.";
  if (!ROLES.includes(row.role as PermissionRole)) fields.role = "Role must be viewer, editor, or manager.";
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { email, role: row.role as PermissionRole } };
}

function stripDocumentExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function documentUrl(workspaceId: string, path: string): string {
  const readablePath = stripDocumentExtension(path)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${env.appUrl}/w/${encodeURIComponent(workspaceId)}/p/${readablePath}`;
}

function folderUrl(workspaceId: string): string {
  return `${env.appUrl}/w/${encodeURIComponent(workspaceId)}`;
}

async function sendPermissionGrantNotification(input: {
  recipientEmail: string;
  workspaceName: string;
  workspaceId: string;
  resourceType: PermissionResourceType;
  resourceName: string;
  resourcePath: string;
  role: PermissionRole;
  auth: AuthContext;
  log: { warn: (payload: object, message?: string) => void };
}): Promise<void> {
  const actor = await prisma.user.findUnique({ where: { id: input.auth.userId }, select: { email: true, name: true } });
  const openUrl =
    input.resourceType === "document"
      ? documentUrl(input.workspaceId, input.resourcePath)
      : folderUrl(input.workspaceId);
  try {
    await getMailer().sendPermissionGranted(input.recipientEmail, {
      actorName: actor?.name || actor?.email || "A workspace manager",
      actorEmail: actor?.email,
      workspaceName: input.workspaceName,
      resourceType: input.resourceType,
      resourceName: input.resourceName,
      role: input.role,
      openUrl,
    });
  } catch (err) {
    input.log.warn({ err, recipientEmail: input.recipientEmail, resourceType: input.resourceType }, "permission grant email failed");
  }
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

interface PersistedRow {
  id: string;
  userId: string | null;
  groupId: string | null;
  role: PermissionRole;
}

// Synthesize the legacy (subjectType, subjectId) view from the new XOR columns so
// the API contract is unchanged while the DB only stores userId/groupId.
function rowSubject(row: { userId: string | null; groupId: string | null }): { subjectType: PermissionSubjectType; subjectId: string } {
  if (row.userId) return { subjectType: "user", subjectId: row.userId };
  if (row.groupId) return { subjectType: "group", subjectId: row.groupId };
  // The XOR check guarantees one is set; this branch is unreachable. Throwing
  // here keeps the type assertion honest without hiding a real bug.
  throw new Error("Permission row missing both userId and groupId");
}

async function currentPermissionRows(
  client: Prisma.TransactionClient | typeof prisma,
  workspaceId: string,
  resourceType: PermissionResourceType,
  resourceId: string,
): Promise<PersistedRow[]> {
  const rows = await client.permission.findMany({
    where: { workspaceId, resourceType, resourceId },
    select: { id: true, userId: true, groupId: true, role: true },
    orderBy: [{ userId: "asc" }, { groupId: "asc" }],
  });
  return rows;
}

async function listPermissions(reply: FastifyReply, workspaceId: string, resourceType: PermissionResourceType, resourceId: string) {
  const permissions = await currentPermissionRows(prisma, workspaceId, resourceType, resourceId);
  const withSubject = permissions.map((permission) => ({
    id: permission.id,
    ...rowSubject(permission),
    role: permission.role,
  }));
  return reply.send({
    version: permissionVersion(withSubject),
    permissions: withSubject,
  });
}

async function replacePermissions(
  workspaceId: string,
  resourceType: PermissionResourceType,
  resourceId: string,
  rows: Array<{ subjectType: PermissionSubjectType; subjectId: string; role: PermissionRole }>,
  baseVersion: string | null,
  auth: AuthContext,
): Promise<ReplacePermissionsOutcome> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<ReplacePermissionsOutcome> => {
    // Re-verify manage permission under the transaction so a concurrent revoke is honored.
    const az =
      resourceType === "document"
        ? await authorizeDocumentRole(auth, resourceId, "manager", tx)
        : await authorizeFolderRole(auth, resourceId, "manager", tx);
    if (!az.ok) return az;
    const current = await currentPermissionRows(tx, workspaceId, resourceType, resourceId);
    const currentVersion = permissionVersion(current.map((p) => ({ ...rowSubject(p), role: p.role })));
    if (baseVersion && baseVersion !== currentVersion) {
      return { ok: false, status: "conflict", currentVersion };
    }
    const currentDirectUserRoles = new Map(
      current.flatMap((permission) => (permission.userId ? [[permission.userId, permission.role] as const] : [])),
    );
    const directUserRowsToNotify = rows.filter(
      (row) => row.subjectType === "user" && currentDirectUserRoles.get(row.subjectId) !== row.role,
    );
    await tx.permission.deleteMany({ where: { workspaceId, resourceType, resourceId } });
    if (rows.length > 0) {
      // A3 cutover: write only userId/groupId — the legacy subjectType/subjectId
      // columns have been dropped from the schema. API request bodies still
      // accept subjectType/subjectId so existing clients keep working.
      await tx.permission.createMany({
        data: rows.map((row) => ({
          workspaceId,
          resourceType,
          resourceId,
          userId: row.subjectType === "user" ? row.subjectId : null,
          groupId: row.subjectType === "group" ? row.subjectId : null,
          role: row.role,
        })),
      });
    }
    await writeAuditEvent(
      { workspaceId, userId: auth.userId, action: "permissions_replaced", targetType: resourceType, targetId: resourceId, metadata: { count: rows.length } },
      tx,
    );
    const usersToNotify =
      directUserRowsToNotify.length > 0
        ? await tx.user.findMany({
            where: { id: { in: directUserRowsToNotify.map((row) => row.subjectId) } },
            select: { id: true, email: true, name: true },
          })
        : [];
    const usersById = new Map(usersToNotify.map((user) => [user.id, user]));
    return {
      ok: true,
      version: permissionVersion(rows),
      notifications: directUserRowsToNotify.flatMap((row) => {
        const user = usersById.get(row.subjectId);
        return user ? [{ user, role: row.role }] : [];
      }),
    };
  });
}

async function grantPermissionByEmail(
  workspaceId: string,
  resourceType: PermissionResourceType,
  resourceId: string,
  email: string,
  role: PermissionRole,
  auth: AuthContext,
): Promise<GrantPermissionOutcome> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<GrantPermissionOutcome> => {
    const az =
      resourceType === "document"
        ? await authorizeDocumentRole(auth, resourceId, "manager", tx)
        : await authorizeFolderRole(auth, resourceId, "manager", tx);
    if (!az.ok) return az;

    const user = await tx.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true },
    });
    if (!user) return { ok: false, status: "unknown_user" };

    const membership = await tx.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      select: { id: true },
    });
    let membershipCreated = false;
    if (!membership) {
      await tx.workspaceMembership.create({
        data: { workspaceId, userId: user.id, role: "guest" },
      });
      membershipCreated = true;
    }

    const existing = await tx.permission.findFirst({
      where: { workspaceId, resourceType, resourceId, userId: user.id },
      select: { id: true },
    });
    if (existing) {
      await tx.permission.update({ where: { id: existing.id }, data: { role } });
    } else {
      await tx.permission.create({
        data: { workspaceId, resourceType, resourceId, userId: user.id, groupId: null, role },
      });
    }

    await writeAuditEvent(
      {
        workspaceId,
        userId: auth.userId,
        action: "permission_granted",
        targetType: resourceType,
        targetId: resourceId,
        metadata: { email, role, membershipCreated },
      },
      tx,
    );

    const current = await currentPermissionRows(tx, workspaceId, resourceType, resourceId);
    const withSubject = current.map((p) => ({ ...rowSubject(p), role: p.role }));
    return {
      ok: true,
      version: permissionVersion(withSubject),
      membershipCreated,
      permission: { subjectType: "user", subjectId: user.id, role },
      user,
    };
  });
}

export async function registerPermissionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/documents/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const doc = await prisma.document.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: { id: true, workspaceId: true, title: true, path: true, workspace: { select: { name: true } } },
    });
    if (!doc) return notFound(reply, "Document not found.");
    const role = await resolveDocumentRole(auth.userId, doc.id);
    if (role === null) return notFound(reply, "Document not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    return listPermissions(reply, doc.workspaceId, "document", doc.id);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/documents/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const doc = await prisma.document.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: { id: true, workspaceId: true, title: true, path: true, workspace: { select: { name: true } } },
    });
    if (!doc) return notFound(reply, "Document not found.");
    const role = await resolveDocumentRole(auth.userId, doc.id);
    if (role === null) return notFound(reply, "Document not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    const parsed = validatePermissions(request.body);
    if (!parsed.ok) return validationError(reply, { permissions: parsed.message });
    const subjectError = await invalidSubject(doc.workspaceId, parsed.value);
    if (subjectError) return validationError(reply, { permissions: subjectError });
    const outcome = await replacePermissions(doc.workspaceId, "document", doc.id, parsed.value, parsed.version, auth);
    if (!outcome.ok) {
      if (outcome.status === "not_found") return notFound(reply, "Document not found.");
      if (outcome.status === "conflict") {
        return reply.code(409).send({ error: "conflict", currentVersion: outcome.currentVersion, message: "Permissions changed on the server." });
      }
      return forbidden(reply);
    }
    for (const notification of outcome.notifications) {
      await sendPermissionGrantNotification({
        recipientEmail: notification.user.email,
        workspaceName: doc.workspace.name,
        workspaceId: doc.workspaceId,
        resourceType: "document",
        resourceName: doc.title,
        resourcePath: doc.path,
        role: notification.role,
        auth,
        log: request.log,
      });
    }
    return { ok: true, version: outcome.version };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/documents/:id/permissions/grant",
    { config: { rateLimit: { max: Number(process.env.PERMISSION_GRANT_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const parsed = validateGrant(request.body);
      if (!parsed.ok) return validationError(reply, parsed.fields);
      const doc = await prisma.document.findFirst({
        where: { id: request.params.id, deletedAt: null },
        select: { id: true, workspaceId: true, title: true, path: true, workspace: { select: { name: true } } },
      });
      if (!doc) return notFound(reply, "Document not found.");
      const outcome = await grantPermissionByEmail(doc.workspaceId, "document", doc.id, parsed.value.email, parsed.value.role, auth);
      if (!outcome.ok) {
        if (outcome.status === "not_found") return notFound(reply, "Document not found.");
        if (outcome.status === "unknown_user") return validationError(reply, { email: "No PageDen user exists with this email yet. Ask them to sign up first, then share again." });
        return forbidden(reply);
      }
      await sendPermissionGrantNotification({
        recipientEmail: outcome.user.email,
        workspaceName: doc.workspace.name,
        workspaceId: doc.workspaceId,
        resourceType: "document",
        resourceName: doc.title,
        resourcePath: doc.path,
        role: parsed.value.role,
        auth,
        log: request.log,
      });
      return outcome;
    },
  );

  app.get<{ Params: { id: string } }>("/api/folders/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const folder = await prisma.folder.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: { id: true, workspaceId: true, name: true, path: true, workspace: { select: { name: true } } },
    });
    if (!folder) return notFound(reply, "Folder not found.");
    const role = await resolveFolderRole(auth.userId, folder.id);
    if (role === null) return notFound(reply, "Folder not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    return listPermissions(reply, folder.workspaceId, "folder", folder.id);
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/folders/:id/permissions", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const folder = await prisma.folder.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: { id: true, workspaceId: true, name: true, path: true, workspace: { select: { name: true } } },
    });
    if (!folder) return notFound(reply, "Folder not found.");
    const role = await resolveFolderRole(auth.userId, folder.id);
    if (role === null) return notFound(reply, "Folder not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    const parsed = validatePermissions(request.body);
    if (!parsed.ok) return validationError(reply, { permissions: parsed.message });
    const subjectError = await invalidSubject(folder.workspaceId, parsed.value);
    if (subjectError) return validationError(reply, { permissions: subjectError });
    const outcome = await replacePermissions(folder.workspaceId, "folder", folder.id, parsed.value, parsed.version, auth);
    if (!outcome.ok) {
      if (outcome.status === "not_found") return notFound(reply, "Folder not found.");
      if (outcome.status === "conflict") {
        return reply.code(409).send({ error: "conflict", currentVersion: outcome.currentVersion, message: "Permissions changed on the server." });
      }
      return forbidden(reply);
    }
    for (const notification of outcome.notifications) {
      await sendPermissionGrantNotification({
        recipientEmail: notification.user.email,
        workspaceName: folder.workspace.name,
        workspaceId: folder.workspaceId,
        resourceType: "folder",
        resourceName: folder.name,
        resourcePath: folder.path,
        role: notification.role,
        auth,
        log: request.log,
      });
    }
    return { ok: true, version: outcome.version };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/folders/:id/permissions/grant",
    { config: { rateLimit: { max: Number(process.env.PERMISSION_GRANT_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const parsed = validateGrant(request.body);
      if (!parsed.ok) return validationError(reply, parsed.fields);
      const folder = await prisma.folder.findFirst({
        where: { id: request.params.id, deletedAt: null },
        select: { id: true, workspaceId: true, name: true, path: true, workspace: { select: { name: true } } },
      });
      if (!folder) return notFound(reply, "Folder not found.");
      const outcome = await grantPermissionByEmail(folder.workspaceId, "folder", folder.id, parsed.value.email, parsed.value.role, auth);
      if (!outcome.ok) {
        if (outcome.status === "not_found") return notFound(reply, "Folder not found.");
        if (outcome.status === "unknown_user") return validationError(reply, { email: "No PageDen user exists with this email yet. Ask them to sign up first, then share again." });
        return forbidden(reply);
      }
      await sendPermissionGrantNotification({
        recipientEmail: outcome.user.email,
        workspaceName: folder.workspace.name,
        workspaceId: folder.workspaceId,
        resourceType: "folder",
        resourceName: folder.name,
        resourcePath: folder.path,
        role: parsed.value.role,
        auth,
        log: request.log,
      });
      return outcome;
    },
  );
}
