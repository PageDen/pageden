import type { Prisma } from "@prisma/client";

// Serialize folder-tree structural mutations within a workspace using a Postgres
// transaction-scoped advisory lock. This eliminates the deadlock from per-row lock
// ordering on concurrent moves and guarantees cascadePaths sees a consistent subtree
// (Codex round-2 BLOCKERs). The lock auto-releases at commit/rollback.
export async function lockFolderTree(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pageden:folder-tree'), hashtext(${workspaceId}))`;
}

export async function lockFolderTrees(
  tx: Prisma.TransactionClient,
  workspaceIds: string[],
): Promise<void> {
  for (const workspaceId of [...new Set(workspaceIds)].sort()) {
    await lockFolderTree(tx, workspaceId);
  }
}
