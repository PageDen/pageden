import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { readBlob, readContent, writeBlob, writeContent } from "./storage.js";

type Tx = Prisma.TransactionClient;

export interface StorageTransferPlan {
  revisionStorageKeys: Map<string, string>;
  attachmentStorageKeys: Map<string, string>;
}

export async function copyDocumentStorageForWorkspace(
  documentIds: string[],
  destinationWorkspaceId: string,
): Promise<StorageTransferPlan> {
  const revisionStorageKeys = new Map<string, string>();
  const attachmentStorageKeys = new Map<string, string>();
  if (documentIds.length === 0) return { revisionStorageKeys, attachmentStorageKeys };

  const revisions = await prisma.documentRevision.findMany({
    where: { documentId: { in: documentIds } },
    select: { id: true, storageKey: true },
  });
  for (const revision of revisions) {
    const content = await readContent(revision.storageKey);
    const copied = await writeContent(content, destinationWorkspaceId);
    revisionStorageKeys.set(revision.id, copied.storageKey);
  }

  const attachments = await prisma.attachment.findMany({
    where: { documentId: { in: documentIds }, deletedAt: null },
    select: { id: true, storageKey: true },
  });
  for (const attachment of attachments) {
    const data = await readBlob(attachment.storageKey);
    const copied = await writeBlob(data, destinationWorkspaceId);
    attachmentStorageKeys.set(attachment.id, copied.storageKey);
  }

  return { revisionStorageKeys, attachmentStorageKeys };
}

export async function applyDocumentStorageTransfer(
  tx: Tx,
  plan: StorageTransferPlan,
): Promise<void> {
  for (const [revisionId, storageKey] of plan.revisionStorageKeys) {
    await tx.documentRevision.update({ where: { id: revisionId }, data: { storageKey } });
  }
  for (const [attachmentId, storageKey] of plan.attachmentStorageKeys) {
    await tx.attachment.update({ where: { id: attachmentId }, data: { storageKey } });
  }
}

export async function updateDocumentScopedWorkspaceRows(
  tx: Tx,
  documentIds: string[],
  destinationWorkspaceId: string,
): Promise<void> {
  if (documentIds.length === 0) return;
  await tx.attachment.updateMany({ where: { documentId: { in: documentIds } }, data: { workspaceId: destinationWorkspaceId } });
  await tx.documentComment.updateMany({ where: { documentId: { in: documentIds } }, data: { workspaceId: destinationWorkspaceId } });
  await tx.tokenReadCursor.updateMany({ where: { documentId: { in: documentIds } }, data: { workspaceId: destinationWorkspaceId } });
  await tx.documentClaim.updateMany({ where: { documentId: { in: documentIds } }, data: { workspaceId: destinationWorkspaceId } });
  await tx.documentShare.updateMany({ where: { documentId: { in: documentIds } }, data: { workspaceId: destinationWorkspaceId } });
}
