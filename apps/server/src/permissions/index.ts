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

/** Cap a role so it can't exceed `max`. Used by the workspace-wide viewer tier. */
export function capRole(role: Role | null, max: Role): Role | null {
  if (!role) return null;
  return RANK[role] > RANK[max] ? max : role;
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

// Walk the folder chain returning the strongest non-null defaultRole — the floor
// every workspace member gets on docs in this folder (and descendants). Null means
// "private", which is the historical behavior. Note we keep walking past the
// nearest set value because a deeper folder's defaultRole could be MORE permissive
// than an ancestor's (e.g. ancestor=viewer, descendant=editor → editor wins). The
// `strongest()` at the call site does the final reconciliation.
async function inheritedDefaultRoles(
  folderId: string,
  client: DbClient = defaultPrisma,
): Promise<Role[]> {
  const roles: Role[] = [];
  let currentId: string | null = folderId;
  while (currentId) {
    const folder: { id: string; parentFolderId: string | null; defaultRole: Role | null } | null =
      await client.folder.findFirst({
        where: { id: currentId, deletedAt: null },
        select: { id: true, parentFolderId: true, defaultRole: true },
      });
    if (!folder) break;
    if (folder.defaultRole) roles.push(folder.defaultRole);
    currentId = folder.parentFolderId;
  }
  return roles;
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
  // Default-role floor for any workspace member from the folder chain. Guests
  // skip these — they only see what they're explicitly granted.
  const inheritedFloors =
    membership.role === "guest" ? [] : await inheritedDefaultRoles(document.folderId, client);

  // Phase B: a workspace-wide "viewer" tier sees every doc as at least viewer.
  const viewerFloor: Role[] = membership.role === "viewer" ? ["viewer"] : [];
  const roles: Role[] = [...viewerFloor, ...inheritedFloors];
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

  const computed = strongest(roles);
  // Viewer tier caps the role at viewer so a stale higher grant can never
  // unlock writes after a workspace role downgrade.
  return membership.role === "viewer" ? capRole(computed, "viewer") : computed;
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
  const inheritedFloors =
    membership.role === "guest" ? [] : await inheritedDefaultRoles(folderId, client);
  const viewerFloor: Role[] = membership.role === "viewer" ? ["viewer"] : [];
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
  const computed = strongest([
    ...viewerFloor,
    ...inheritedFloors,
    ...permissions.map((permission) => roleName(permission.role)),
  ]);
  return membership.role === "viewer" ? capRole(computed, "viewer") : computed;
}

// ---------------------------------------------------------------------------
// Capability map — the per-doc { canEdit, canDelete, canShare, ... } block the
// API serializes so the frontend can hide actions without re-deriving the role
// → action matrix. Keeping the rules here means a permission policy change
// flips both server enforcement and UI affordances in lockstep.
// ---------------------------------------------------------------------------

export interface Capabilities {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canManage: boolean;
  canComment: boolean;
  canShare: boolean;
}

export function capabilitiesFor(role: Role | null): Capabilities {
  if (!role) {
    return { canView: false, canEdit: false, canDelete: false, canManage: false, canComment: false, canShare: false };
  }
  // Comments are open to any reader (see documents/comments.ts: create requires
  // any role, resolve/delete requires author-or-manager).
  return {
    canView: true,
    canEdit: atLeast(role, "editor"),
    canDelete: atLeast(role, "manager"),
    canManage: atLeast(role, "manager"),
    canComment: true,
    canShare: atLeast(role, "manager"),
  };
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
