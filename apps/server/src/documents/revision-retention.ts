import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";

type Client = PrismaClient | Prisma.TransactionClient;

export async function pruneCollapsedRevisions(
  client: Client = defaultPrisma,
  opts: { olderThanMs?: number; now?: Date } = {},
): Promise<{ pruned: number; groupsScanned: number }> {
  const olderThanMs = opts.olderThanMs ?? Number(process.env.REVISION_PRUNE_AFTER_MS ?? 30 * 24 * 60 * 60 * 1000);
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanMs);

  const rows = await client.documentRevision.findMany({
    where: {
      prunedAt: null,
      createdAt: { lt: cutoff },
      OR: [{ revisionGroupId: { not: null } }, { revisionGroupId: null }],
    },
    select: {
      id: true,
      documentId: true,
      versionNumber: true,
      revisionGroupId: true,
      createdAt: true,
      changeSource: true,
      message: true,
      isPinned: true,
      label: true,
    },
    orderBy: [{ documentId: "asc" }, { versionNumber: "desc" }],
  });

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.documentId}:${row.revisionGroupId ?? row.id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const pruneIds: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.versionNumber - a.versionNumber);
    const candidates = sorted.slice(1).filter((row) => {
      if (row.createdAt >= cutoff) return false;
      if (row.message) return false;
      if (row.isPinned || row.label) return false;
      if (row.changeSource === "import" || row.changeSource === "system") return false;
      return true;
    });
    pruneIds.push(...candidates.map((row) => row.id));
  }

  if (!pruneIds.length) return { pruned: 0, groupsScanned: groups.size };
  const result = await client.documentRevision.updateMany({
    where: { id: { in: pruneIds }, prunedAt: null },
    data: { prunedAt: now },
  });
  return { pruned: result.count, groupsScanned: groups.size };
}
