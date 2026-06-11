import { prisma } from "./prisma.js";

export type AiReadinessIssue = { code: string; severity: "info" | "warning"; message: string };

export type DocumentContext = ReturnType<typeof documentContext>;

export function documentContext(content: string) {
  const parsed = parseFrontmatter(content);
  const body = parsed ? content.slice(parsed.endIndex).replace(/^\s+/, "") : content;
  return {
    body,
    frontmatter: parsed?.data ?? {},
    headings: extractHeadings(body),
    wikilinks: extractWikiLinks(body),
  };
}

export async function aiReadinessForDocument({
  workspaceId,
  title,
  updatedAt,
  context,
}: {
  workspaceId: string;
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
  if (/\b(TODO|TBD|FIXME)\b|\[\s\]|\?\?\?/.test(body)) {
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

  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.length - warningCount;
  const score = Math.max(0, 100 - warningCount * 22 - infoCount * 8);
  return {
    status: warningCount ? "needs_attention" : score < 90 ? "usable" : "ready",
    score,
    issues,
  };
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
