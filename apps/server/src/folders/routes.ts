import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { buildFolderPath, isValidSlug, rerootPath } from "../paths.js";
import { forbidden, isUniqueViolation, notFound, validationError } from "../errors.js";
import { atLeast, authorizeFolderRole, canManageWorkspace, resolveFolderRole } from "../permissions/index.js";
import { lockFolderTree, lockFolderTrees } from "../db.js";
import { applyDocumentStorageTransfer, copyDocumentStorageForWorkspace, updateDocumentScopedWorkspaceRows } from "../workspace-transfer.js";

type Tx = Prisma.TransactionClient;

async function siblingFolderSlugTaken(
  tx: Tx,
  workspaceId: string,
  parentFolderId: string | null,
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  const existing = await tx.folder.findFirst({
    where: {
      workspaceId,
      parentFolderId,
      slug,
      deletedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  return existing !== null;
}

// All active descendants of a folder (excluding the folder itself), via repeated level
// queries. Small trees in MVP; replace with a recursive CTE if depth/breadth grows.
async function descendantFolders(
  tx: Tx,
  workspaceId: string,
  rootId: string,
): Promise<Array<{ id: string; path: string }>> {
  const collected: Array<{ id: string; path: string }> = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const children = await tx.folder.findMany({
      where: { workspaceId, parentFolderId: { in: frontier }, deletedAt: null },
      select: { id: true, path: true },
    });
    if (children.length === 0) break;
    collected.push(...children);
    frontier = children.map((child) => child.id);
  }
  return collected;
}

// Re-root the moved/renamed folder subtree: update the folder's own path plus every
// descendant folder and document path, all inside the caller's transaction (review H1).
async function cascadePaths(
  tx: Tx,
  workspaceId: string,
  folderId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const descendants = await descendantFolders(tx, workspaceId, folderId);
  for (const descendant of descendants) {
    await tx.folder.update({
      where: { id: descendant.id },
      data: { path: rerootPath(descendant.path, oldPath, newPath) },
    });
  }
  const folderIds = [folderId, ...descendants.map((d) => d.id)];
  const documents = await tx.document.findMany({
    where: { folderId: { in: folderIds }, deletedAt: null },
    select: { id: true, path: true },
  });
  for (const document of documents) {
    await tx.document.update({
      where: { id: document.id },
      data: { path: rerootPath(document.path, oldPath, newPath) },
    });
  }
}

export async function registerFolderRoutes(app: FastifyInstance): Promise<void> {
  // Create a folder. Root folders require workspace admin; child folders require editor on the parent.
  app.post<{
    Body: { workspaceId?: string; parentFolderId?: string | null; name?: string; slug?: string };
  }>("/api/folders", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "create");
    const { workspaceId } = request.body;
    const parentFolderId = request.body.parentFolderId ?? null;
    const name = request.body.name?.trim();
    const slug = request.body.slug?.trim().toLowerCase();

    const fields: Record<string, string> = {};
    if (!workspaceId) fields.workspaceId = "workspaceId is required.";
    if (!name) fields.name = "Name is required.";
    if (!slug) fields.slug = "Slug is required.";
    else if (!isValidSlug(slug)) fields.slug = "Slug must be lowercase letters, numbers, and hyphens.";
    if (Object.keys(fields).length > 0) return validationError(reply, fields);

    // Permission check (best-effort, pre-lock). Authoritative path/existence is read under lock.
    if (parentFolderId) {
      const parent = await prisma.folder.findFirst({
        where: { id: parentFolderId, workspaceId: workspaceId!, deletedAt: null },
        select: { id: true },
      });
      if (!parent) return notFound(reply, "Parent folder not found.");
      const parentRole = await resolveFolderRole(auth.userId, parent.id);
      if (parentRole === null) return notFound(reply, "Parent folder not found.");
      if (!atLeast(parentRole, "editor")) return forbidden(reply);
    } else if (!(await canManageWorkspace(auth.userId, workspaceId!))) {
      return forbidden(reply, "Only workspace admins can create root folders.");
    }

    const result = await prisma
      .$transaction(async (tx) => {
        await lockFolderTree(tx, workspaceId!);
        // Re-read parent path AND re-verify permission under the lock.
        let parentPath: string | null = null;
        if (parentFolderId) {
          const parent = await tx.folder.findFirst({
            where: { id: parentFolderId, workspaceId: workspaceId!, deletedAt: null },
            select: { path: true },
          });
          if (!parent) return { status: "parent_missing" as const };
          const az = await authorizeFolderRole(auth, parentFolderId, "editor", tx);
          if (!az.ok) return az.status === "not_found" ? { status: "parent_missing" as const } : { status: "forbidden" as const };
          parentPath = parent.path;
        } else if (!(await canManageWorkspace(auth.userId, workspaceId!, tx))) {
          return { status: "forbidden" as const };
        }
        const path = buildFolderPath(parentPath, slug!);
        if (await siblingFolderSlugTaken(tx, workspaceId!, parentFolderId, slug!)) {
          return { status: "collision" as const };
        }
        const folder = await tx.folder.create({
          data: {
            workspaceId: workspaceId!,
            parentFolderId,
            name: name!,
            slug: slug!,
            path,
            createdById: auth.userId,
            updatedById: auth.userId,
          },
        });
        await writeAuditEvent(
          { workspaceId: workspaceId!, userId: auth.userId, action: "folder_created", targetType: "folder", targetId: folder.id, metadata: { path } },
          tx,
        );
        return { status: "ok" as const, id: folder.id, path: folder.path };
      })
      .catch((error) => {
        if (isUniqueViolation(error)) return { status: "collision" as const };
        throw error;
      });
    if (result.status === "parent_missing") return notFound(reply, "Parent folder not found.");
    if (result.status === "forbidden") return forbidden(reply);
    if (result.status === "collision") return validationError(reply, { slug: "A folder with this slug already exists here." });
    return reply.code(201).send({ id: result.id, path: result.path });
  });

  // Rename (manager): change name/slug and re-root the subtree.
  app.post<{ Params: { id: string }; Body: { name?: string; slug?: string } }>(
    "/api/folders/:id/rename",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const slug = request.body.slug?.trim().toLowerCase();
      if (!slug) return validationError(reply, { slug: "Slug is required." });
      if (!isValidSlug(slug)) return validationError(reply, { slug: "Slug must be lowercase letters, numbers, and hyphens." });

      const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!folder) return notFound(reply, "Folder not found.");
      const role = await resolveFolderRole(auth.userId, folder.id);
      if (role === null) return notFound(reply, "Folder not found.");
      if (!atLeast(role, "manager")) return forbidden(reply);

      const name = request.body.name?.trim() ?? folder.name;

      const result = await prisma
        .$transaction(async (tx) => {
          await lockFolderTree(tx, folder.workspaceId);
          // Re-read the folder (its current path + parent) under the lock.
          const locked = await tx.$queryRaw<Array<{ path: string; parentFolderId: string | null }>>`
            SELECT "path", "parentFolderId" FROM "Folder" WHERE "id" = ${folder.id} AND "deletedAt" IS NULL FOR UPDATE`;
          if (locked.length === 0) return { status: "gone" as const };
          const az = await authorizeFolderRole(auth, folder.id, "manager", tx);
          if (!az.ok) return az.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
          const oldPath = locked[0]!.path;
          const parentFolderId = locked[0]!.parentFolderId;
          // Compute the new path from the parent's CURRENT path under the lock.
          let parentPath: string | null = null;
          if (parentFolderId) {
            const parent = await tx.folder.findFirst({
              where: { id: parentFolderId, deletedAt: null },
              select: { path: true },
            });
            parentPath = parent?.path ?? null;
          }
          const newPath = buildFolderPath(parentPath, slug);
          if (await siblingFolderSlugTaken(tx, folder.workspaceId, parentFolderId, slug, folder.id)) {
            return { status: "collision" as const };
          }
          await tx.folder.update({ where: { id: folder.id }, data: { name, slug, path: newPath, updatedById: auth.userId } });
          await cascadePaths(tx, folder.workspaceId, folder.id, oldPath, newPath);
          await writeAuditEvent(
            { workspaceId: folder.workspaceId, userId: auth.userId, action: "folder_renamed", targetType: "folder", targetId: folder.id, metadata: { path: newPath } },
            tx,
          );
          return { status: "ok" as const, path: newPath };
        })
        .catch((error) => {
          if (isUniqueViolation(error)) return { status: "collision" as const };
          throw error;
        });
      if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Folder not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "collision") return validationError(reply, { slug: "A folder with this slug already exists here." });
      return { id: folder.id, path: result.path };
    },
  );

  // Move (manager on folder + editor on destination). Rejects cycles.
  app.post<{ Params: { id: string }; Body: { parentFolderId?: string | null } }>(
    "/api/folders/:id/move",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const destParentId = request.body.parentFolderId ?? null;

      const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!folder) return notFound(reply, "Folder not found.");
      const role = await resolveFolderRole(auth.userId, folder.id);
      if (role === null) return notFound(reply, "Folder not found.");
      if (!atLeast(role, "manager")) return forbidden(reply);

      if (destParentId) {
        if (destParentId === folder.id) return validationError(reply, { parentFolderId: "A folder cannot be moved into itself." });
        const dest = await prisma.folder.findFirst({
          where: { id: destParentId, workspaceId: folder.workspaceId, deletedAt: null },
          select: { id: true },
        });
        if (!dest) return notFound(reply, "Destination folder not found.");
        const destRole = await resolveFolderRole(auth.userId, dest.id);
        if (destRole === null) return notFound(reply, "Destination folder not found.");
        if (!atLeast(destRole, "editor")) return forbidden(reply);
      } else if (!(await canManageWorkspace(auth.userId, folder.workspaceId))) {
        return forbidden(reply, "Only workspace admins can move a folder to the root.");
      }

      // Lock source + destination and recompute the descendant set inside the transaction so
      // concurrent moves cannot interleave into a cycle or corrupt cascaded paths (BLOCKER 1).
      const result = await prisma
        .$transaction(async (tx) => {
          await lockFolderTree(tx, folder.workspaceId);
          const lockedSrc = await tx.$queryRaw<Array<{ path: string }>>`
            SELECT "path" FROM "Folder" WHERE "id" = ${folder.id} AND "deletedAt" IS NULL FOR UPDATE`;
          if (lockedSrc.length === 0) return { status: "gone" as const };
          const azSrc = await authorizeFolderRole(auth, folder.id, "manager", tx);
          if (!azSrc.ok) return azSrc.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
          const oldPath = lockedSrc[0]!.path;

          let parentPath: string | null = null;
          if (destParentId) {
            const lockedDest = await tx.$queryRaw<Array<{ path: string }>>`
              SELECT "path" FROM "Folder"
              WHERE "id" = ${destParentId} AND "workspaceId" = ${folder.workspaceId} AND "deletedAt" IS NULL FOR UPDATE`;
            if (lockedDest.length === 0) return { status: "dest_missing" as const };
            const azDest = await authorizeFolderRole(auth, destParentId, "editor", tx);
            if (!azDest.ok) return azDest.status === "not_found" ? { status: "dest_missing" as const } : { status: "forbidden" as const };
            parentPath = lockedDest[0]!.path;
            const descendants = await descendantFolders(tx, folder.workspaceId, folder.id);
            const blocked = new Set<string>([folder.id, ...descendants.map((d) => d.id)]);
            if (blocked.has(destParentId)) return { status: "cycle" as const };
          } else if (!(await canManageWorkspace(auth.userId, folder.workspaceId, tx))) {
            return { status: "forbidden" as const };
          }

          const newPath = buildFolderPath(parentPath, folder.slug);
          if (await siblingFolderSlugTaken(tx, folder.workspaceId, destParentId, folder.slug, folder.id)) {
            return { status: "collision" as const };
          }
          await tx.folder.update({ where: { id: folder.id }, data: { parentFolderId: destParentId, path: newPath, updatedById: auth.userId } });
          await cascadePaths(tx, folder.workspaceId, folder.id, oldPath, newPath);
          await writeAuditEvent(
            { workspaceId: folder.workspaceId, userId: auth.userId, action: "folder_moved", targetType: "folder", targetId: folder.id, metadata: { parentFolderId: destParentId, path: newPath } },
            tx,
          );
          return { status: "ok" as const, path: newPath };
        })
        .catch((error) => {
          if (isUniqueViolation(error)) return { status: "collision" as const };
          throw error;
        });

      if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Folder not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "dest_missing") return notFound(reply, "Destination folder not found.");
      if (result.status === "cycle") return validationError(reply, { parentFolderId: "A folder cannot be moved into its own subtree." });
      if (result.status === "collision") return validationError(reply, { slug: "A folder with this slug already exists in the destination." });
      return { id: folder.id, parentFolderId: destParentId, path: result.path };
    },
  );

  // Transfer a folder subtree to another workspace. The moved folder can land at
  // the destination root (destination admin required) or under a destination
  // folder (destination editor required). Explicit permissions on moved folders
  // and documents are cleared so destination inheritance applies.
  app.post<{ Params: { id: string }; Body: { workspaceId?: string; parentFolderId?: string | null } }>(
    "/api/folders/:id/transfer-workspace",
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const destinationWorkspaceId = request.body.workspaceId;
      const destinationParentId = request.body.parentFolderId ?? null;
      if (!destinationWorkspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });

      const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!folder) return notFound(reply, "Folder not found.");
      if (destinationWorkspaceId === folder.workspaceId) return validationError(reply, { workspaceId: "Use Move for moves inside the same workspace." });

      const sourceWorkspace = await prisma.workspace.findUnique({
        where: { id: folder.workspaceId },
        select: { workspaceTransferEnabled: true },
      });
      if (!sourceWorkspace?.workspaceTransferEnabled) return forbidden(reply, "Workspace transfer is disabled for this workspace.");

      const role = await resolveFolderRole(auth.userId, folder.id);
      if (role === null) return notFound(reply, "Folder not found.");
      if (!atLeast(role, "manager")) return forbidden(reply);

      if (destinationParentId) {
        const dest = await prisma.folder.findFirst({
          where: { id: destinationParentId, workspaceId: destinationWorkspaceId, deletedAt: null },
          select: { id: true },
        });
        if (!dest) return notFound(reply, "Destination folder not found.");
        const destRole = await resolveFolderRole(auth.userId, dest.id);
        if (destRole === null) return notFound(reply, "Destination folder not found.");
        if (!atLeast(destRole, "editor")) return forbidden(reply);
      } else if (!(await canManageWorkspace(auth.userId, destinationWorkspaceId))) {
        return forbidden(reply, "Only destination workspace admins can move a folder to the root.");
      }

      const result = await prisma
        .$transaction(async (tx) => {
          await lockFolderTrees(tx, [folder.workspaceId, destinationWorkspaceId]);
          const lockedSrc = await tx.$queryRaw<Array<{ path: string; workspaceId: string }>>`
            SELECT "path", "workspaceId" FROM "Folder" WHERE "id" = ${folder.id} AND "deletedAt" IS NULL FOR UPDATE`;
          if (lockedSrc.length === 0) return { status: "gone" as const };
          if (lockedSrc[0]!.workspaceId !== folder.workspaceId) return { status: "gone" as const };
          const azSrc = await authorizeFolderRole(auth, folder.id, "manager", tx);
          if (!azSrc.ok) return azSrc.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
          const source = await tx.workspace.findUnique({
            where: { id: folder.workspaceId },
            select: { workspaceTransferEnabled: true },
          });
          if (!source?.workspaceTransferEnabled) return { status: "transfer_disabled" as const };

          let parentPath: string | null = null;
          if (destinationParentId) {
            const lockedDest = await tx.$queryRaw<Array<{ path: string }>>`
              SELECT "path" FROM "Folder"
              WHERE "id" = ${destinationParentId} AND "workspaceId" = ${destinationWorkspaceId} AND "deletedAt" IS NULL FOR UPDATE`;
            if (lockedDest.length === 0) return { status: "dest_missing" as const };
            const azDest = await authorizeFolderRole(auth, destinationParentId, "editor", tx);
            if (!azDest.ok) return azDest.status === "not_found" ? { status: "dest_missing" as const } : { status: "forbidden" as const };
            parentPath = lockedDest[0]!.path;
          } else if (!(await canManageWorkspace(auth.userId, destinationWorkspaceId, tx))) {
            return { status: "forbidden" as const };
          }

          if (await siblingFolderSlugTaken(tx, destinationWorkspaceId, destinationParentId, folder.slug)) {
            return { status: "collision" as const };
          }

          const oldPath = lockedSrc[0]!.path;
          const newPath = buildFolderPath(parentPath, folder.slug);
          const descendants = await descendantFolders(tx, folder.workspaceId, folder.id);
          const folderIds = [folder.id, ...descendants.map((descendant) => descendant.id)];
          const documents = await tx.document.findMany({
            where: { workspaceId: folder.workspaceId, folderId: { in: folderIds }, deletedAt: null },
            select: { id: true, path: true, supersededById: true },
          });
          const documentIds = documents.map((document) => document.id);
          const movedDocumentIds = new Set(documentIds);

          const storagePlan = await copyDocumentStorageForWorkspace(documentIds, destinationWorkspaceId);
          await applyDocumentStorageTransfer(tx, storagePlan);
          await updateDocumentScopedWorkspaceRows(tx, documentIds, destinationWorkspaceId);

          await tx.folder.update({
            where: { id: folder.id },
            data: {
              workspaceId: destinationWorkspaceId,
              parentFolderId: destinationParentId,
              path: newPath,
              updatedById: auth.userId,
            },
          });
          for (const descendant of descendants) {
            await tx.folder.update({
              where: { id: descendant.id },
              data: { workspaceId: destinationWorkspaceId, path: rerootPath(descendant.path, oldPath, newPath) },
            });
          }

          for (const document of documents) {
            await tx.document.update({
              where: { id: document.id },
              data: {
                workspaceId: destinationWorkspaceId,
                path: rerootPath(document.path, oldPath, newPath),
                supersededById: document.supersededById && movedDocumentIds.has(document.supersededById) ? document.supersededById : null,
                updatedById: auth.userId,
              },
            });
          }

          await tx.permission.deleteMany({
            where: {
              workspaceId: folder.workspaceId,
              OR: [
                { resourceType: "folder", resourceId: { in: folderIds } },
                ...(documentIds.length ? [{ resourceType: "document" as const, resourceId: { in: documentIds } }] : []),
              ],
            },
          });

          const metadata = {
            fromWorkspaceId: folder.workspaceId,
            toWorkspaceId: destinationWorkspaceId,
            fromPath: oldPath,
            toPath: newPath,
            movedDocuments: documentIds.length,
            movedFolders: folderIds.length,
          };
          await writeAuditEvent(
            { workspaceId: folder.workspaceId, userId: auth.userId, action: "folder_workspace_moved_out", targetType: "folder", targetId: folder.id, metadata },
            tx,
          );
          await writeAuditEvent(
            { workspaceId: destinationWorkspaceId, userId: auth.userId, action: "folder_workspace_moved_in", targetType: "folder", targetId: folder.id, metadata },
            tx,
          );
          return { status: "ok" as const, path: newPath, movedDocuments: documentIds.length, movedFolders: folderIds.length };
        })
        .catch((error) => {
          if (isUniqueViolation(error)) return { status: "collision" as const };
          throw error;
        });

      if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Folder not found.");
      if (result.status === "forbidden") return forbidden(reply);
      if (result.status === "transfer_disabled") return forbidden(reply, "Workspace transfer is disabled for this workspace.");
      if (result.status === "dest_missing") return notFound(reply, "Destination folder not found.");
      if (result.status === "collision") return validationError(reply, { slug: "A folder with this slug already exists in the destination." });
      return {
        id: folder.id,
        workspaceId: destinationWorkspaceId,
        parentFolderId: destinationParentId,
        path: result.path,
        movedDocuments: result.movedDocuments,
        movedFolders: result.movedFolders,
      };
    },
  );

  // Delete (manager). MVP rejects non-empty folders.
  app.delete<{ Params: { id: string } }>("/api/folders/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!folder) return notFound(reply, "Folder not found.");
    const role = await resolveFolderRole(auth.userId, folder.id);
    if (role === null) return notFound(reply, "Folder not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);

    const deletedAt = new Date();
    const result = await prisma.$transaction(async (tx) => {
      // Serialize with create/move so a child cannot attach between the emptiness check and delete.
      await lockFolderTree(tx, folder.workspaceId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Folder" WHERE "id" = ${folder.id} AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length === 0) return { status: "gone" as const };
      const az = await authorizeFolderRole(auth, folder.id, "manager", tx);
      if (!az.ok) return az.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };
      const childFolder = await tx.folder.findFirst({ where: { parentFolderId: folder.id, deletedAt: null }, select: { id: true } });
      const childDoc = await tx.document.findFirst({ where: { folderId: folder.id, deletedAt: null }, select: { id: true } });
      if (childFolder || childDoc) return { status: "not_empty" as const };
      await tx.folder.update({ where: { id: folder.id }, data: { deletedAt } });
      await tx.permission.deleteMany({ where: { workspaceId: folder.workspaceId, resourceType: "folder", resourceId: folder.id } });
      await writeAuditEvent(
        { workspaceId: folder.workspaceId, userId: auth.userId, action: "folder_deleted", targetType: "folder", targetId: folder.id },
        tx,
      );
      return { status: "ok" as const };
    });
    if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Folder not found.");
    if (result.status === "forbidden") return forbidden(reply);
    if (result.status === "not_empty") return validationError(reply, { folder: "Folder is not empty. Remove its contents first." });
    return { ok: true };
  });

  // Empty (manager): soft-delete all descendant folders and documents while keeping this folder.
  app.post<{ Params: { id: string }; Body?: { confirmationName?: string } }>("/api/folders/:id/empty", async (request, reply) => {
    const auth = await requireAuth(request);
    requireTokenScope(auth, "update");
    const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!folder) return notFound(reply, "Folder not found.");
    const role = await resolveFolderRole(auth.userId, folder.id);
    if (role === null) return notFound(reply, "Folder not found.");
    if (!atLeast(role, "manager")) return forbidden(reply);
    const confirmationName = request.body?.confirmationName ?? "";
    if (confirmationName !== folder.name) {
      return validationError(reply, { confirmationName: "Type the folder name exactly to empty this folder." });
    }

    const deletedAt = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await lockFolderTree(tx, folder.workspaceId);
      const locked = await tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "Folder" WHERE "id" = ${folder.id} AND "deletedAt" IS NULL FOR UPDATE`;
      if (locked.length === 0) return { status: "gone" as const };
      if (locked[0]!.name !== confirmationName) {
        return { status: "confirmation_mismatch" as const };
      }
      const az = await authorizeFolderRole(auth, folder.id, "manager", tx);
      if (!az.ok) return az.status === "not_found" ? { status: "not_found" as const } : { status: "forbidden" as const };

      const descendants = await descendantFolders(tx, folder.workspaceId, folder.id);
      const folderIds = [folder.id, ...descendants.map((descendant) => descendant.id)];
      const documents = await tx.document.findMany({
        where: { workspaceId: folder.workspaceId, folderId: { in: folderIds }, deletedAt: null },
        select: { id: true },
      });
      const descendantFolderIds = descendants.map((descendant) => descendant.id);
      const documentIds = documents.map((document) => document.id);

      if (documentIds.length > 0) {
        await tx.document.updateMany({ where: { id: { in: documentIds }, deletedAt: null }, data: { deletedAt } });
        await tx.permission.deleteMany({
          where: { workspaceId: folder.workspaceId, resourceType: "document", resourceId: { in: documentIds } },
        });
      }
      if (descendantFolderIds.length > 0) {
        await tx.folder.updateMany({ where: { id: { in: descendantFolderIds }, deletedAt: null }, data: { deletedAt } });
        await tx.permission.deleteMany({
          where: { workspaceId: folder.workspaceId, resourceType: "folder", resourceId: { in: descendantFolderIds } },
        });
      }

      await writeAuditEvent(
        {
          workspaceId: folder.workspaceId,
          userId: auth.userId,
          action: "folder_emptied",
          targetType: "folder",
          targetId: folder.id,
          metadata: { deletedDocuments: documentIds.length, deletedFolders: descendantFolderIds.length },
        },
        tx,
      );
      return { status: "ok" as const, deletedDocuments: documentIds.length, deletedFolders: descendantFolderIds.length };
    });
    if (result.status === "gone" || result.status === "not_found") return notFound(reply, "Folder not found.");
    if (result.status === "forbidden") return forbidden(reply);
    if (result.status === "confirmation_mismatch") {
      return validationError(reply, { confirmationName: "Type the folder name exactly to empty this folder." });
    }
    return { ok: true, deletedDocuments: result.deletedDocuments, deletedFolders: result.deletedFolders };
  });

  // Set/clear the default role floor for the folder (manager-gated). Setting it to
  // "viewer" / "editor" / "manager" makes every workspace member at least that role
  // on the folder and its descendants; setting null restores the historical private
  // behavior (explicit grants only). See Phase A1 in pageden-dev/docs/permission-model-review-outline-docmost.md.
  app.put<{ Params: { id: string }; Body: { defaultRole?: "viewer" | "editor" | "manager" | null } }>(
    "/api/folders/:id/default-role",
    { config: { rateLimit: { max: Number(process.env.FOLDER_DEFAULT_ROLE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const next = request.body?.defaultRole ?? null;
      if (next !== null && next !== "viewer" && next !== "editor" && next !== "manager") {
        return validationError(reply, { defaultRole: "defaultRole must be viewer, editor, manager, or null." });
      }
      const folder = await prisma.folder.findFirst({ where: { id: request.params.id, deletedAt: null } });
      if (!folder) return notFound(reply, "Folder not found.");
      const role = await resolveFolderRole(auth.userId, folder.id);
      if (role === null) return notFound(reply, "Folder not found.");
      if (!atLeast(role, "manager")) return forbidden(reply);

      const previous = folder.defaultRole;
      const updated = await prisma.folder.update({
        where: { id: folder.id },
        data: { defaultRole: next, updatedById: auth.userId },
        select: { id: true, defaultRole: true },
      });
      await writeAuditEvent({
        workspaceId: folder.workspaceId,
        userId: auth.userId,
        action: "folder_default_role_changed",
        targetType: "folder",
        targetId: folder.id,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        metadata: { previous, next },
      });
      return { id: updated.id, defaultRole: updated.defaultRole };
    },
  );
}
