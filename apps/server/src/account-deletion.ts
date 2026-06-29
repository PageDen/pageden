import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env } from "./env.js";
import { prisma } from "./prisma.js";
import { hashToken } from "./tokens.js";
import { removeStorageKey, removeStoragePrefix } from "./storage.js";

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE";
export const ACCOUNT_DELETION_CODE_TTL_MS = 10 * 60 * 1000;
const DELETED_USER_EMAIL = "deleted-user@pageden.system";

export interface AccountDeletionWorkspace {
  id: string;
  name: string;
}

export interface AccountDeletionPreview {
  userEmail: string;
  soleWorkspaces: AccountDeletionWorkspace[];
  sharedWorkspaces: Array<AccountDeletionWorkspace & { otherMemberCount: number }>;
}

export function generateAccountDeletionCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashAccountDeletionCode(userId: string, code: string): string {
  return hashToken(`account-delete:${userId}:${code}`, env.tokenHashSecret);
}

export async function accountDeletionPreview(userId: string): Promise<AccountDeletionPreview> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      workspaceMemberships: {
        select: {
          workspace: {
            select: {
              id: true,
              name: true,
              _count: { select: { members: true } },
            },
          },
        },
      },
    },
  });

  const soleWorkspaces: AccountDeletionWorkspace[] = [];
  const sharedWorkspaces: Array<AccountDeletionWorkspace & { otherMemberCount: number }> = [];
  for (const membership of user.workspaceMemberships) {
    const workspace = membership.workspace;
    if (workspace._count.members <= 1) {
      soleWorkspaces.push({ id: workspace.id, name: workspace.name });
    } else {
      sharedWorkspaces.push({ id: workspace.id, name: workspace.name, otherMemberCount: workspace._count.members - 1 });
    }
  }
  return { userEmail: user.email, soleWorkspaces, sharedWorkspaces };
}

export async function createAccountDeletionCode(userId: string, code: string, ipAddress?: string): Promise<Date> {
  const expiresAt = new Date(Date.now() + ACCOUNT_DELETION_CODE_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.accountDeletionCode.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.accountDeletionCode.create({
      data: {
        userId,
        codeHash: hashAccountDeletionCode(userId, code),
        expiresAt,
        ipAddress,
      },
    });
  });
  return expiresAt;
}

export async function deleteAccountAndData(
  userId: string,
  onStorageCleanupError?: (error: unknown) => void,
): Promise<{ deletedWorkspaces: number; removedStorageObjects: number }> {
  const preview = await accountDeletionPreview(userId);
  const soleWorkspaceIds = preview.soleWorkspaces.map((workspace) => workspace.id);

  const [revisionKeys, attachmentKeys] = soleWorkspaceIds.length
    ? await Promise.all([
        prisma.documentRevision.findMany({
          where: { document: { workspaceId: { in: soleWorkspaceIds } } },
          select: { storageKey: true },
        }),
        prisma.attachment.findMany({
          where: { workspaceId: { in: soleWorkspaceIds } },
          select: { storageKey: true },
        }),
      ])
    : [[], []];
  const legacyKeys = [...new Set([...revisionKeys, ...attachmentKeys].map((row) => row.storageKey).filter((key) => !key.startsWith("workspaces/")))];

  await prisma.$transaction(async (tx) => {
    const deletedUser = await ensureDeletedUser(tx);

    await tx.folder.updateMany({ where: { createdById: userId }, data: { createdById: deletedUser.id } });
    await tx.folder.updateMany({ where: { updatedById: userId }, data: { updatedById: deletedUser.id } });
    await tx.document.updateMany({ where: { createdById: userId }, data: { createdById: deletedUser.id } });
    await tx.document.updateMany({ where: { updatedById: userId }, data: { updatedById: deletedUser.id } });
    await tx.documentRevision.updateMany({ where: { createdById: userId }, data: { createdById: deletedUser.id } });
    await tx.attachment.updateMany({ where: { uploadedById: userId }, data: { uploadedById: deletedUser.id } });
    await tx.documentComment.updateMany({ where: { authorUserId: userId }, data: { authorUserId: deletedUser.id } });
    await tx.documentComment.updateMany({ where: { resolvedById: userId }, data: { resolvedById: deletedUser.id } });
    await tx.documentShare.updateMany({ where: { createdById: userId }, data: { createdById: deletedUser.id } });
    await tx.documentClaim.deleteMany({ where: { userId } });
    await tx.permission.deleteMany({ where: { userId } });
    await tx.deviceAuthRequest.deleteMany({ where: { userId } });
    await tx.accountDeletionCode.deleteMany({ where: { userId } });
    if (soleWorkspaceIds.length) {
      await tx.workspace.deleteMany({ where: { id: { in: soleWorkspaceIds } } });
    }
    await tx.user.delete({ where: { id: userId } });
  });

  let removedStorageObjects = 0;
  try {
    for (const workspaceId of soleWorkspaceIds) {
      removedStorageObjects += await removeStoragePrefix(`workspaces/${workspaceId}/`);
    }
    removedStorageObjects += await removeUnreferencedLegacyKeys(legacyKeys);
  } catch (error) {
    onStorageCleanupError?.(error);
  }

  return { deletedWorkspaces: soleWorkspaceIds.length, removedStorageObjects };
}

async function ensureDeletedUser(tx: Prisma.TransactionClient): Promise<{ id: string }> {
  return tx.user.upsert({
    where: { email: DELETED_USER_EMAIL },
    update: {},
    create: {
      email: DELETED_USER_EMAIL,
      name: "Deleted user",
      passwordHash: null,
      emailVerified: true,
    },
    select: { id: true },
  });
}

async function removeUnreferencedLegacyKeys(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const [referencedRevisions, referencedAttachments] = await Promise.all([
    prisma.documentRevision.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } }),
    prisma.attachment.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } }),
  ]);
  const referenced = new Set([...referencedRevisions, ...referencedAttachments].map((row) => row.storageKey));
  let removed = 0;
  for (const key of keys) {
    if (referenced.has(key)) continue;
    await removeStorageKey(key);
    removed += 1;
  }
  return removed;
}
