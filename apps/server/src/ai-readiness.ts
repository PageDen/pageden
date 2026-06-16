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

// Heading extraction. The original regex (/^(#{1,6})\s+(.+)$/gm + a follow-up
// /\s+#+$/) trips CodeQL's polynomial-redos rule because each `\s+` plus `.+`
// can backtrack on pathological input. Linear scan per line avoids that.
function extractHeadings(content: string): Array<{ level: number; title: string; anchor: string }> {
  const headings: Array<{ level: number; title: string; anchor: string }> = [];
  for (const rawLine of content.split("\n")) {
    let i = 0;
    let level = 0;
    while (i < rawLine.length && rawLine.charCodeAt(i) === 35 /* # */ && level < 6) {
      i += 1;
      level += 1;
    }
    if (level === 0) continue;
    if (i >= rawLine.length) continue;
    const next = rawLine.charCodeAt(i);
    if (next !== 32 && next !== 9) continue;
    while (i < rawLine.length) {
      const c = rawLine.charCodeAt(i);
      if (c !== 32 && c !== 9) break;
      i += 1;
    }
    const title = stripTrailingAtxClosing(rawLine.slice(i)).trim();
    if (!title) continue;
    headings.push({ level, title, anchor: anchorFor(title) });
  }
  return headings;
}

// Strip a trailing ATX-style closing run of `#`s and the whitespace separating
// them. Hand-rolled to avoid the `\s+#+$` regex backtracking on long
// trailing-whitespace inputs.
function stripTrailingAtxClosing(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end -= 1;
  }
  let hashStart = end;
  while (hashStart > 0 && s.charCodeAt(hashStart - 1) === 35) hashStart -= 1;
  if (hashStart === end || hashStart === 0) return s.slice(0, end);
  const before = s.charCodeAt(hashStart - 1);
  if (before !== 32 && before !== 9) return s.slice(0, end);
  let stop = hashStart - 1;
  while (stop > 0) {
    const c = s.charCodeAt(stop - 1);
    if (c !== 32 && c !== 9) break;
    stop -= 1;
  }
  return s.slice(0, stop);
}

// Wikilink extraction. The original /!?\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g
// trips polynomial-redos because the unanchored character class `[^\]#|]+`
// blows up on `[[[[...` inputs. Linear scan with explicit boundary checks.
function extractWikiLinks(content: string): string[] {
  const links = new Set<string>();
  let i = 0;
  while (i < content.length) {
    const start = i;
    if (content.charCodeAt(i) === 33 /* ! */) i += 1;
    if (content.charCodeAt(i) !== 91 /* [ */ || content.charCodeAt(i + 1) !== 91) {
      i = start + 1;
      continue;
    }
    i += 2;
    const targetStart = i;
    while (i < content.length) {
      const c = content.charCodeAt(i);
      if (c === 93 /* ] */ || c === 35 /* # */ || c === 124 /* | */) break;
      i += 1;
    }
    if (i === targetStart) {
      i = start + 1;
      continue;
    }
    const target = content.slice(targetStart, i).trim();
    if (content.charCodeAt(i) === 35 || content.charCodeAt(i) === 124) {
      i += 1;
      while (i < content.length && content.charCodeAt(i) !== 93) i += 1;
    }
    if (content.charCodeAt(i) === 93 && content.charCodeAt(i + 1) === 93) {
      if (target) links.add(target);
      i += 2;
    } else {
      i = start + 1;
    }
  }
  return [...links].sort((a, b) => a.localeCompare(b));
}

// Anchor slug for a heading. Both /[^a-z0-9]+/g and /^-+|-+$/g flagged by
// polynomial-redos, so we drop them in favour of a single linear pass that
// (a) drops the punctuation set, (b) collapses runs of non-alphanumeric to a
// single `-`, (c) trims the result of leading/trailing dashes.
function anchorFor(value: string): string {
  const lower = value.toLowerCase();
  let out = "";
  let lastWasDash = false;
  for (let i = 0; i < lower.length; i += 1) {
    const c = lower.charCodeAt(i);
    // Drop characters from the original /[`*_~[\]().,!?;:'"]/ set.
    if (
      c === 96 || c === 42 || c === 95 || c === 126 || c === 91 || c === 93 ||
      c === 40 || c === 41 || c === 46 || c === 44 || c === 33 || c === 63 ||
      c === 59 || c === 58 || c === 39 || c === 34
    ) {
      continue;
    }
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += lower[i];
      lastWasDash = false;
    } else if (!lastWasDash) {
      out += "-";
      lastWasDash = true;
    }
  }
  let s = 0;
  while (s < out.length && out.charCodeAt(s) === 45 /* - */) s += 1;
  let e = out.length;
  while (e > s && out.charCodeAt(e - 1) === 45) e -= 1;
  return out.slice(s, e);
}
