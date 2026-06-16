import { prisma } from "../prisma.js";
import { readContent } from "../storage.js";
import { documentContext } from "../ai-readiness.js";
import { extractDecisions } from "./handoff.js";

export interface DocStats {
  documentId: string;
  workspaceId: string;
  chars: number;
  tokenEstimate: number;
  /** Suggested chunk size in characters for a single read call. */
  chunkRecommendation: number;
  wikilinkCount: number;
  brokenWikilinkCount: number;
  decisionCount: number;
  /** Open (unresolved) comment count. */
  openCommentCount: number;
  /** Resolved comment count, for context. */
  resolvedCommentCount: number;
}

// Tunable — based on the existing read endpoint default (50000) plus enough
// headroom for headings/metadata. Agents sized for ~32K input tokens can fit a
// 100K-char doc in two reads; bigger ones may need more.
const DEFAULT_CHUNK_TARGET = 50_000;

/**
 * Quick "what shape is this doc?" view so an agent can pick a read strategy
 * before committing tool calls. Closes Feature 16 from
 * ai-agent-workspace-improvements.md — the session pain point was that an agent
 * couldn't tell a 312KB master plan from a 5KB note until trying to read it.
 *
 * The numbers are approximations, not source-of-truth. Token estimate uses the
 * common 4-chars/token rule of thumb; pick a tokenizer if you need precision.
 */
export async function documentStatsFor(documentId: string): Promise<DocStats | null> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true, currentVersionId: true },
  });
  if (!doc) return null;

  let content = "";
  if (doc.currentVersionId) {
    const revision = await prisma.documentRevision.findUnique({
      where: { id: doc.currentVersionId },
      select: { storageKey: true },
    });
    if (revision) {
      try {
        content = await readContent(revision.storageKey);
      } catch {
        content = "";
      }
    }
  }

  const ctx = documentContext(content);
  const wikilinkCount = ctx.wikilinks.length;
  const brokenWikilinkCount = await countBrokenWikilinks(doc.workspaceId, ctx.wikilinks);
  const decisionCount = extractDecisions(ctx.body).length;

  const openCommentCount = await prisma.documentComment.count({
    where: { documentId, resolvedAt: null },
  });
  const resolvedCommentCount = await prisma.documentComment.count({
    where: { documentId, resolvedAt: { not: null } },
  });

  const chars = content.length;
  const tokenEstimate = Math.ceil(chars / 4);
  const chunkRecommendation = chars <= DEFAULT_CHUNK_TARGET ? chars : DEFAULT_CHUNK_TARGET;

  return {
    documentId: doc.id,
    workspaceId: doc.workspaceId,
    chars,
    tokenEstimate,
    chunkRecommendation,
    wikilinkCount,
    brokenWikilinkCount,
    decisionCount,
    openCommentCount,
    resolvedCommentCount,
  };
}

// Lightweight broken-link count that mirrors the AI-readiness scan logic
// without duplicating the warning surface — we only need a number here.
async function countBrokenWikilinks(workspaceId: string, wikilinks: string[]): Promise<number> {
  if (wikilinks.length === 0) return 0;
  const docs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { title: true, path: true },
  });
  const known = new Set<string>();
  for (const doc of docs) {
    known.add(normalize(doc.title));
    known.add(normalize(doc.path));
    known.add(normalize(doc.path.replace(/\.md$/i, "")));
    const tail = doc.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    if (tail) known.add(normalize(tail));
  }
  let broken = 0;
  for (const link of wikilinks) {
    if (isLikelyAttachment(link)) continue;
    if (!known.has(normalize(link))) broken += 1;
  }
  return broken;
}

function normalize(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
}

function isLikelyAttachment(value: string): boolean {
  return /\.(avif|bmp|gif|heic|jpeg|jpg|mov|mp3|mp4|pdf|png|svg|webm|webp|zip)$/i.test(value.trim());
}
