import { prisma } from "../prisma.js";
import { readContent } from "../storage.js";

export interface DiffResult {
  documentId: string;
  fromVersion: string;
  toVersion: string;
  /** Unified-diff text suitable for display in a viewer or terminal. */
  unified: string;
  /** Quick numbers for callers that only need a summary, not the prose. */
  added: number;
  removed: number;
  unchanged: number;
}

interface RevisionEndpoint {
  id: string;
  documentId: string;
  storageKey: string;
}

async function resolveRevision(documentId: string, versionId: string): Promise<RevisionEndpoint | null> {
  const revision = await prisma.documentRevision.findUnique({
    where: { id: versionId },
    select: { id: true, documentId: true, storageKey: true },
  });
  if (!revision || revision.documentId !== documentId) return null;
  return revision;
}

/**
 * Closes Feature 14 from ai-agent-workspace-improvements.md — agents could not
 * verify that a write actually did what they intended without re-reading the
 * whole doc. Compares the bodies of two revisions of the same document and
 * returns a unified-diff text + summary counts.
 *
 * Uses an LCS-based line diff. Sufficient for review/audit; not trying to
 * outperform `git diff` on huge files.
 */
export async function documentDiffFor(
  documentId: string,
  fromVersion: string,
  toVersion: string,
): Promise<DiffResult | { error: "not_found" } | { error: "same_version" }> {
  if (fromVersion === toVersion) return { error: "same_version" };
  const [from, to] = await Promise.all([
    resolveRevision(documentId, fromVersion),
    resolveRevision(documentId, toVersion),
  ]);
  if (!from || !to) return { error: "not_found" };

  const [fromBody, toBody] = await Promise.all([readContent(from.storageKey), readContent(to.storageKey)]);
  const fromLines = fromBody.split("\n");
  const toLines = toBody.split("\n");
  const ops = lineDiff(fromLines, toLines);

  const lines: string[] = [];
  lines.push(`--- a/${documentId}@${fromVersion}`);
  lines.push(`+++ b/${documentId}@${toVersion}`);
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.kind === "add") {
      lines.push(`+${op.line}`);
      added += 1;
    } else if (op.kind === "remove") {
      lines.push(`-${op.line}`);
      removed += 1;
    } else {
      lines.push(` ${op.line}`);
      unchanged += 1;
    }
  }
  return {
    documentId,
    fromVersion,
    toVersion,
    unified: lines.join("\n"),
    added,
    removed,
    unchanged,
  };
}

type DiffOp = { kind: "add" | "remove" | "equal"; line: string };

// Compute LCS-driven diff between two arrays of lines. O(N*M) memory which is
// fine for documents up to ~MBs. Switch to Myers if we ever need to diff
// very large bodies.
function lineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", line: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "remove", line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "remove", line: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", line: b[j]! });
    j += 1;
  }
  return ops;
}
