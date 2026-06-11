import type { Role } from "@pageden/api-types";
import { prisma } from "../prisma.js";
import { strongest } from "./index.js";

export interface FolderNode {
  id: string;
  parentFolderId: string | null;
  name: string;
  slug: string;
  path: string;
}

// Workspace-scoped resolver: loads the user's grants and the folder tree once, then answers
// effective-role questions in memory. Avoids N+1 permission queries when listing.
export interface WorkspaceResolver {
  workspaceId: string;
  isAdmin: boolean;
  folders: FolderNode[];
  folderRole(folderId: string): Role | null;
  documentRole(doc: { id: string; folderId: string }): Role | null;
  ancestorFolderIds(folderId: string): string[];
}

export async function buildWorkspaceResolver(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceResolver> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  const isAdmin = membership?.role === "admin";
  const isMember = membership !== null;

  const groupIds = (
    await prisma.groupMembership.findMany({
      where: { userId, group: { workspaceId } },
      select: { groupId: true },
    })
  ).map((membership) => membership.groupId);

  const subjectOR = [
    { subjectType: "user" as const, subjectId: userId },
    ...groupIds.map((id) => ({ subjectType: "group" as const, subjectId: id })),
  ];

  const permissions = await prisma.permission.findMany({
    where: { workspaceId, OR: subjectOR },
    select: { resourceType: true, resourceId: true, role: true },
  });

  const folderGrants = new Map<string, Role[]>();
  const documentGrants = new Map<string, Role[]>();
  for (const permission of permissions) {
    const target = permission.resourceType === "folder" ? folderGrants : documentGrants;
    const list = target.get(permission.resourceId) ?? [];
    list.push(permission.role);
    target.set(permission.resourceId, list);
  }

  const folders = await prisma.folder.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, parentFolderId: true, name: true, slug: true, path: true },
  });
  const parentOf = new Map<string, string | null>();
  const activeFolderIds = new Set<string>();
  for (const folder of folders) {
    parentOf.set(folder.id, folder.parentFolderId);
    activeFolderIds.add(folder.id);
  }

  // Only walk active folders; a missing/deleted folder ends the ancestry chain so that
  // list/tree authorization matches the per-item resolver (which filters deletedAt: null).
  function ancestorFolderIds(folderId: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    let current: string | null | undefined = folderId;
    while (current && !seen.has(current) && activeFolderIds.has(current)) {
      seen.add(current);
      ids.push(current);
      current = parentOf.get(current) ?? null;
    }
    return ids;
  }

  function folderRole(folderId: string): Role | null {
    if (!isMember) return null;
    if (isAdmin) return "manager";
    const roles: Role[] = [];
    for (const id of ancestorFolderIds(folderId)) {
      const grants = folderGrants.get(id);
      if (grants) roles.push(...grants);
    }
    return strongest(roles);
  }

  function documentRole(doc: { id: string; folderId: string }): Role | null {
    if (!isMember) return null;
    if (isAdmin) return "manager";
    const roles: Role[] = [];
    const inherited = folderRole(doc.folderId);
    if (inherited) roles.push(inherited);
    const grants = documentGrants.get(doc.id);
    if (grants) roles.push(...grants);
    return strongest(roles);
  }

  return { workspaceId, isAdmin, folders, folderRole, documentRole, ancestorFolderIds };
}
