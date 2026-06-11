import type { Role } from "@pageden/api-types";
import type { PermissionRole, Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;
import { prisma as defaultPrisma } from "../prisma.js";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, manager: 3 };

/** Strongest role wins (no explicit deny in MVP). */
export function strongest(roles: Role[]): Role | null {
  if (roles.length === 0) return null;
  return roles.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
}

export function atLeast(role: Role | null, needed: Role): boolean {
  return role != null && RANK[role] >= RANK[needed];
}

function roleName(role: PermissionRole): Role {
  return role;
}

async function groupIdsForUser(
  userId: string,
  workspaceId: string,
  client: DbClient = defaultPrisma,
): Promise<string[]> {
  // Scope to the workspace so a cross-workspace group can never grant access here.
  const memberships = await client.groupMembership.findMany({
    where: { userId, group: { workspaceId } },
    select: { groupId: true },
  });
  return memberships.map((membership) => membership.groupId);
}

async function inheritedFolderIds(
  folderId: string,
  client: DbClient = defaultPrisma,
): Promise<string[]> {
  const ids: string[] = [];
  let currentId: string | null = folderId;
  while (currentId) {
    const folder: { id: string; parentFolderId: string | null } | null = await client.folder.findFirst({
      where: { id: currentId, deletedAt: null },
      select: { id: true, parentFolderId: true },
    });
    if (!folder) break;
    ids.push(folder.id);
    currentId = folder.parentFolderId;
  }
  return ids;
}

export async function canManageWorkspace(
  userId: string,
  workspaceId: string,
  client: DbClient = defaultPrisma,
): Promise<boolean> {
  const membership = await client.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  return membership?.role === "admin";
}

export async function resolveDocumentRole(
  userId: string,
  documentId: string,
  client: DbClient = defaultPrisma,
): Promise<Role | null> {
  const document = await client.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true, folderId: true },
  });
  if (!document) return null;
  // Require current workspace membership: a lingering grant after a removed membership
  // must not resolve to access (Codex round-2). Admins are members with role 'admin'.
  const membership = await client.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: document.workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) return null;
  if (membership.role === "admin") return "manager";

  const groupIds = await groupIdsForUser(userId, document.workspaceId, client);
  const folderIds = await inheritedFolderIds(document.folderId, client);

  const roles: Role[] = [];
  const collectSubjectFilters = [
    { subjectType: "user" as const, subjectId: userId },
    ...groupIds.map((groupId) => ({ subjectType: "group" as const, subjectId: groupId })),
  ];

  const folderPermissions = await client.permission.findMany({
    where: {
      workspaceId: document.workspaceId,
      resourceType: "folder",
      resourceId: { in: folderIds },
      OR: collectSubjectFilters,
    },
    select: { role: true },
  });
  roles.push(...folderPermissions.map((permission) => roleName(permission.role)));

  const documentPermissions = await client.permission.findMany({
    where: {
      workspaceId: document.workspaceId,
      resourceType: "document",
      resourceId: document.id,
      OR: collectSubjectFilters,
    },
    select: { role: true },
  });
  roles.push(...documentPermissions.map((permission) => roleName(permission.role)));

  return strongest(roles);
}

export async function canReadDocument(
  userId: string,
  documentId: string,
  client: DbClient = defaultPrisma,
): Promise<boolean> {
  return atLeast(await resolveDocumentRole(userId, documentId, client), "viewer");
}
export async function canEditDocument(
  userId: string,
  documentId: string,
  client: DbClient = defaultPrisma,
): Promise<boolean> {
  return atLeast(await resolveDocumentRole(userId, documentId, client), "editor");
}
export async function canManageDocument(
  userId: string,
  documentId: string,
  client: DbClient = defaultPrisma,
): Promise<boolean> {
  return atLeast(await resolveDocumentRole(userId, documentId, client), "manager");
}

// ---------------------------------------------------------------------------
// Folder role resolution (Milestone 2). Mirrors document resolution but without
// document-level overrides: workspace admin => manager, else strongest of the
// folder's own + inherited ancestor grants.
// ---------------------------------------------------------------------------

export async function resolveFolderRole(
  userId: string,
  folderId: string,
  client: DbClient = defaultPrisma,
): Promise<Role | null> {
  const folder = await client.folder.findFirst({
    where: { id: folderId, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!folder) return null;
  const membership = await client.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: folder.workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) return null;
  if (membership.role === "admin") return "manager";

  const groupIds = await groupIdsForUser(userId, folder.workspaceId, client);
  const folderIds = await inheritedFolderIds(folderId, client);
  const subjectFilters = [
    { subjectType: "user" as const, subjectId: userId },
    ...groupIds.map((groupId) => ({ subjectType: "group" as const, subjectId: groupId })),
  ];

  const permissions = await client.permission.findMany({
    where: {
      workspaceId: folder.workspaceId,
      resourceType: "folder",
      resourceId: { in: folderIds },
      OR: subjectFilters,
    },
    select: { role: true },
  });
  return strongest(permissions.map((permission) => roleName(permission.role)));
}

export async function canEditFolder(
  userId: string,
  folderId: string,
  client: DbClient = defaultPrisma,
): Promise<boolean> {
  return atLeast(await resolveFolderRole(userId, folderId, client), "editor");
}

export async function canManageFolder(
  userId: string,
  folderId: string,
  client: DbClient = defaultPrisma,
): Promise<boolean> {
  return atLeast(await resolveFolderRole(userId, folderId, client), "manager");
}

// ---------------------------------------------------------------------------
// Authorization outcomes for in-transaction rechecks (Codex round-2): structural
// mutations must re-verify permission under the lock, not just existence, so a
// concurrent permission change cannot slip a mutation through after the pre-check.
// ---------------------------------------------------------------------------

export type Authz = { ok: true } | { ok: false; status: "not_found" | "forbidden" };

export async function authorizeDocumentRole(
  userId: string,
  documentId: string,
  needed: Role,
  client: DbClient = defaultPrisma,
): Promise<Authz> {
  const role = await resolveDocumentRole(userId, documentId, client);
  if (role === null) return { ok: false, status: "not_found" };
  if (!atLeast(role, needed)) return { ok: false, status: "forbidden" };
  return { ok: true };
}

export async function authorizeFolderRole(
  userId: string,
  folderId: string,
  needed: Role,
  client: DbClient = defaultPrisma,
): Promise<Authz> {
  const role = await resolveFolderRole(userId, folderId, client);
  if (role === null) return { ok: false, status: "not_found" };
  if (!atLeast(role, needed)) return { ok: false, status: "forbidden" };
  return { ok: true };
}
