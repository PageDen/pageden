import { prisma } from "./prisma.js";
import { maskCodeContext } from "./documents/markdown-context.js";

export type AiReadinessIssue = { code: string; severity: "info" | "warning"; message: string };

export type DocumentContext = ReturnType<typeof documentContext>;

export function documentContext(content: string) {
  const parsed = parseFrontmatter(content);
  const body = parsed ? content.slice(parsed.endIndex).replace(/^\s+/, "") : content;
  // Feature 17: mask fenced-code-block and inline-code spans before scanning
  // for wikilinks. Headings stay sourced from the raw body so heading
  // navigation isn't affected by code-fence content.
  const masked = maskCodeContext(body);
  return {
    body,
    frontmatter: parsed?.data ?? {},
    headings: extractHeadings(body),
    wikilinks: extractWikiLinks(masked.body),
    codeContextCounts: masked.counts,
  };
}

export async function aiReadinessForDocument({
  workspaceId,
  documentId,
  status,
  title,
  updatedAt,
  context,
}: {
  workspaceId: string;
  documentId?: string;
  status?: string;
  title: string;
  updatedAt: Date;
  context: DocumentContext;
}) {
  const issues: AiReadinessIssue[] = [];
  const body = context.body.trim();

  if (!title.trim() || /^untitled(?: document)?$/i.test(title.trim())) {
    issues.push({ code: "missing_title", severity: "warning", message: "Give this document a descriptive title." });
  }
  if (body.length < 80) {
    issues.push({ code: "thin_content", severity: "info", message: "This document is very short, so agents may not have enough context." });
  }
  if (body.length >= 400 && context.headings.length === 0) {
    issues.push({ code: "missing_headings", severity: "warning", message: "Add headings so agents can navigate the document more reliably." });
  }
  // Feature 17: scan the code-masked body so TODO/checkbox tokens inside
  // fenced examples (e.g. ` ```- [ ] something``` `) don't flag the doc.
  // F15: when the doc declares `checklistMode: execution`, treat `[ ]` as
  // intentional execution checklists and skip the checkbox half of the test —
  // leaves TODO/TBD/FIXME/??? noise still flagged.
  const checklistMode = typeof context.frontmatter.checklistMode === "string" ? context.frontmatter.checklistMode : undefined;
  const checklistExecution = checklistMode?.trim().toLowerCase() === "execution";
  const masked = maskCodeContext(body).body;
  const unresolved = checklistExecution
    ? /\b(TODO|TBD|FIXME)\b|\?\?\?/.test(masked)
    : /\b(TODO|TBD|FIXME)\b|\[\s\]|\?\?\?/.test(masked);
  if (unresolved) {
    issues.push({ code: "unresolved_notes", severity: "info", message: "Resolve TODOs, empty checklist items, or placeholders before relying on this document." });
  }

  const brokenWikilinks = await brokenWikiLinks(workspaceId, context.wikilinks);
  if (brokenWikilinks.length) {
    issues.push({
      code: "broken_wikilinks",
      severity: "warning",
      message: `These wikilinks do not resolve to Pageden documents: ${brokenWikilinks.slice(0, 5).join(", ")}${brokenWikilinks.length > 5 ? "..." : ""}.`,
    });
  }

  const daysSinceUpdate = Math.floor((Date.now() - updatedAt.getTime()) / (24 * 60 * 60 * 1000));
  if (daysSinceUpdate > 180) {
    issues.push({ code: "stale_document", severity: "info", message: `This document has not changed in ${daysSinceUpdate} days.` });
  }

  // Only canonical docs are checked for overlap — superseded/draft/archived
  // docs are expected to share topics with their canonical counterparts.
  if (status === "canonical" || status === undefined) {
    const overlaps = await overlappingCanonicalDocs(workspaceId, documentId ?? null, title);
    if (overlaps.length) {
      issues.push({
        code: "overlapping_canonical_docs",
        severity: "info",
        message: `Other canonical documents may cover the same topic: ${overlaps
          .slice(0, 3)
          .map((doc) => doc.path)
          .join(", ")}${overlaps.length > 3 ? "…" : ""}. Consider marking one superseded.`,
      });
    }
  }

  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.length - warningCount;
  const score = Math.max(0, 100 - warningCount * 22 - infoCount * 8);
  return {
    status: warningCount ? "needs_attention" : score < 90 ? "usable" : "ready",
    score,
    issues,
  };
}

// Title-token Jaccard heuristic for "two canonical docs likely cover the same
// topic". Cheap (one query + in-memory compare) and intentionally conservative:
// only fires above 0.6 overlap so two docs with the same domain keyword don't
// trip it (e.g. "Backup Strategy" vs "Backup Drill" share one token only).
// Surfaces up to 3 candidates with the highest overlap.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "with",
  "doc", "docs", "document", "documents", "plan", "notes", "guide", "readme",
]);

function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

async function overlappingCanonicalDocs(
  workspaceId: string,
  documentId: string | null,
  title: string,
): Promise<Array<{ id: string; title: string; path: string; overlap: number }>> {
  const mine = titleTokens(title);
  if (mine.size < 2) return []; // a one-word title is too noisy to compare against
  const siblings = await prisma.document.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      status: "canonical",
      ...(documentId ? { id: { not: documentId } } : {}),
    },
    select: { id: true, title: true, path: true },
  });
  const scored: Array<{ id: string; title: string; path: string; overlap: number }> = [];
  for (const sibling of siblings) {
    const theirs = titleTokens(sibling.title);
    if (theirs.size < 2) continue;
    const intersection = [...mine].filter((token) => theirs.has(token)).length;
    if (intersection < 2) continue;
    const union = new Set([...mine, ...theirs]).size;
    const overlap = intersection / union;
    if (overlap >= 0.6) scored.push({ ...sibling, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored;
}

async function brokenWikiLinks(workspaceId: string, wikilinks: string[]): Promise<string[]> {
  const docLinks = wikilinks.filter((link) => !isLikelyAttachmentLink(link));
  if (!docLinks.length) return [];
  const docs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { title: true, path: true },
  });
  const known = new Set<string>();
  for (const doc of docs) {
    known.add(normalizeWikiTarget(doc.title));
    known.add(normalizeWikiTarget(doc.path));
    known.add(normalizeWikiTarget(doc.path.replace(/\.md$/i, "")));
    known.add(normalizeWikiTarget(doc.path.split("/").pop()?.replace(/\.md$/i, "") ?? ""));
  }
  return docLinks.filter((link) => !known.has(normalizeWikiTarget(link)));
}

function normalizeWikiTarget(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .toLowerCase();
}

function isLikelyAttachmentLink(value: string): boolean {
  return /\.(avif|bmp|gif|heic|jpeg|jpg|mov|mp3|mp4|pdf|png|svg|webm|webp|zip)$/i.test(value.trim());
}

function parseFrontmatter(content: string): { data: Record<string, string | string[]>; endIndex: number } | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const afterFence = content.indexOf("\n", end + 4);
  const raw = content.slice(4, end);
  const data: Record<string, string | string[]> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => stripYamlQuotes(item.trim()))
        .filter(Boolean);
    } else {
      data[key] = stripYamlQuotes(value);
    }
  }
  return { data, endIndex: afterFence === -1 ? content.length : afterFence + 1 };
}

function stripYamlQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function extractHeadings(content: string): Array<{ level: number; title: string; anchor: string }> {
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  for (const match of content.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    const title = match[2]!.replace(/\s+#+$/, "").trim();
    if (!title) continue;
    headings.push({ level: match[1]!.length, title, anchor: anchorFor(title) });
  }
  return headings;
}

function extractWikiLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/!?\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g)) {
    if (match[1]) links.add(match[1].trim());
  }
  return [...links].sort((a, b) => a.localeCompare(b));
}

function anchorFor(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~[\]().,!?;:'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
