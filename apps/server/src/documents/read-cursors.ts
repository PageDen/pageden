import { prisma } from "../prisma.js";
import type { AuthContext } from "../auth.js";

// "Where was I last time I read this document?" — used by pageden_my_unread to
// answer "what changed since my last look?" without scanning every revision.
// Token-bound agents get a per-token cursor; web users get a per-user cursor.

export async function touchReadCursor(
  auth: AuthContext,
  doc: { id: string; workspaceId: string; currentVersionId: string | null },
): Promise<void> {
  const now = new Date();
  if (auth.tokenId) {
    await prisma.tokenReadCursor.upsert({
      where: { tokenId_documentId: { tokenId: auth.tokenId, documentId: doc.id } },
      create: {
        tokenId: auth.tokenId,
        workspaceId: doc.workspaceId,
        documentId: doc.id,
        lastReadVersion: doc.currentVersionId,
        lastReadAt: now,
      },
      update: { lastReadVersion: doc.currentVersionId, lastReadAt: now },
    });
    return;
  }
  await prisma.tokenReadCursor.upsert({
    where: { userId_documentId: { userId: auth.userId, documentId: doc.id } },
    create: {
      userId: auth.userId,
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      lastReadVersion: doc.currentVersionId,
      lastReadAt: now,
    },
    update: { lastReadVersion: doc.currentVersionId, lastReadAt: now },
  });
}

export interface UnreadDoc {
  id: string;
  folderId: string;
  title: string;
  path: string;
  version: string | null;
  status: string;
  updatedAt: Date;
  lastReadAt: Date | null;
  lastReadVersion: string | null;
  unreadCommentCount: number;
  latestUnreadCommentAt: Date | null;
}

// Return docs in this workspace whose currentVersionId differs from the
// caller's cursor (or which the caller has never read). Permission filtering
// is the caller's responsibility — this only returns rows joined with the
// caller's cursor records.
export async function unreadDocuments(
  auth: AuthContext,
  workspaceId: string,
): Promise<UnreadDoc[]> {
  const docs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, folderId: true, title: true, path: true, currentVersionId: true, status: true, updatedAt: true },
  });
  if (docs.length === 0) return [];
  const cursors = await prisma.tokenReadCursor.findMany({
    where: {
      workspaceId,
      documentId: { in: docs.map((d) => d.id) },
      ...(auth.tokenId ? { tokenId: auth.tokenId } : { userId: auth.userId, tokenId: null }),
    },
    select: { documentId: true, lastReadAt: true, lastReadVersion: true },
  });
  const cursorByDoc = new Map(cursors.map((c) => [c.documentId, c]));
  const result: UnreadDoc[] = [];
  for (const doc of docs) {
    const cursor = cursorByDoc.get(doc.id) ?? null;
    let unreadCommentCount = 0;
    let latestUnreadCommentAt: Date | null = null;
    if (cursor?.lastReadAt) {
      const unreadCommentWhere = {
        documentId: doc.id,
        createdAt: { gt: cursor.lastReadAt },
        ...(auth.tokenId
          ? { OR: [{ authorTokenId: null }, { authorTokenId: { not: auth.tokenId } }] }
          : { OR: [{ authorTokenId: { not: null } }, { authorUserId: { not: auth.userId } }] }),
      };
      const [count, latest] = await Promise.all([
        prisma.documentComment.count({ where: unreadCommentWhere }),
        prisma.documentComment.findFirst({
          where: unreadCommentWhere,
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      unreadCommentCount = count;
      latestUnreadCommentAt = latest?.createdAt ?? null;
    }
    if (cursor && cursor.lastReadVersion === doc.currentVersionId && unreadCommentCount === 0) continue;
    result.push({
      id: doc.id,
      folderId: doc.folderId,
      title: doc.title,
      path: doc.path,
      version: doc.currentVersionId,
      status: doc.status,
      updatedAt: doc.updatedAt,
      lastReadAt: cursor?.lastReadAt ?? null,
      lastReadVersion: cursor?.lastReadVersion ?? null,
      unreadCommentCount,
      latestUnreadCommentAt,
    });
  }
  return result.sort((a, b) => {
    const aLatest = Math.max(a.updatedAt.getTime(), a.latestUnreadCommentAt?.getTime() ?? 0);
    const bLatest = Math.max(b.updatedAt.getTime(), b.latestUnreadCommentAt?.getTime() ?? 0);
    return bLatest - aLatest;
  });
}
