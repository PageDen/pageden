import { prisma } from "../prisma.js";
import { readContent } from "../storage.js";
import { documentContext } from "../ai-readiness.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import type { AuthContext } from "../auth.js";
import { applyDocumentWrite } from "./routes.js";

// F13: a single, transparent normalizer used by both the broken-link warning
// and the workspace wikilink lint. Fuzzy substitutions live HERE so the
// warning message can quote them back.
const TYPOGRAPHIC: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  { pattern: /[\u2010-\u2015\u2212]/g, replacement: "-", label: "en/em dash to hyphen" },
  { pattern: /[\u2018-\u201b]/g, replacement: "'", label: "smart single quote to '" },
  { pattern: /[\u201c-\u201f]/g, replacement: '"', label: "smart double quote to \"" },
  { pattern: /\u00a0/g, replacement: " ", label: "nbsp to space" },
];

export interface ResolutionAttempt {
  step: "title" | "path" | "slug" | "fuzzy";
  notes?: string;
}

export interface SuggestedTarget {
  target: string;
  documentId: string;
  reason: string;
}

export interface BrokenWikilink {
  documentId: string;
  documentTitle: string;
  documentPath: string;
  brokenLink: string;
  attempts: ResolutionAttempt[];
  suggested: SuggestedTarget | null;
}

export interface RewriteReplacement {
  from: string;
  to: string;
}

export interface RewriteOutcomeEntry {
  documentId: string;
  documentPath: string;
  status: "skipped" | "would_write" | "written" | "error";
  occurrences: number;
  error?: string;
  newVersion?: string;
}

export interface RewriteResult {
  workspaceId: string;
  dryRun: boolean;
  changes: RewriteOutcomeEntry[];
}

function applyTypographic(value: string): { value: string; substitutionsApplied: string[] } {
  const subs: string[] = [];
  let out = value;
  for (const { pattern, replacement, label } of TYPOGRAPHIC) {
    if (pattern.test(out)) {
      out = out.replace(pattern, replacement);
      subs.push(label);
    }
    pattern.lastIndex = 0;
  }
  return { value: out, substitutionsApplied: subs };
}

function normalize(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
}

interface DocIndexEntry {
  id: string;
  title: string;
  path: string;
  titleNorm: string;
  pathNorm: string;
  pathNoExt: string;
  slug: string;
}

function buildIndex(docs: Array<{ id: string; title: string; path: string }>): DocIndexEntry[] {
  return docs.map((doc) => ({
    id: doc.id,
    title: doc.title,
    path: doc.path,
    // Also pre-fuzzy the indexed titles + slugs so a typographic difference
    // between an indexed doc (em-dash in title) and a wikilink (hyphen) lines
    // up after one normalization pass on each side.
    titleNorm: normalize(applyTypographic(doc.title).value),
    pathNorm: normalize(applyTypographic(doc.path).value),
    pathNoExt: normalize(applyTypographic(doc.path.replace(/\.md$/i, "")).value),
    slug: normalize(applyTypographic(doc.path.split("/").pop()?.replace(/\.md$/i, "") ?? "").value),
  }));
}

/**
 * F13: try a sequence of resolution strategies and return both the resolved
 * doc (if any) AND the attempts we made along the way. The attempts are
 * surfaced in the lint warning so authors can SEE why their link didn't
 * match.
 */
export function resolveWikilink(
  rawLink: string,
  index: DocIndexEntry[],
): { resolved: DocIndexEntry | null; attempts: ResolutionAttempt[] } {
  const target = normalize(rawLink);
  const attempts: ResolutionAttempt[] = [];

  attempts.push({ step: "title" });
  const byTitle = index.find((doc) => doc.titleNorm === target);
  if (byTitle) return { resolved: byTitle, attempts };

  attempts.push({ step: "path" });
  const byPath = index.find((doc) => doc.pathNorm === target || doc.pathNoExt === target);
  if (byPath) return { resolved: byPath, attempts };

  attempts.push({ step: "slug" });
  const bySlug = index.find((doc) => doc.slug === target);
  if (bySlug) return { resolved: bySlug, attempts };

  const fuzzy = applyTypographic(rawLink);
  if (fuzzy.substitutionsApplied.length) {
    attempts.push({ step: "fuzzy", notes: fuzzy.substitutionsApplied.join(", ") });
    const fuzzyTarget = normalize(fuzzy.value);
    const fuzzyHit = index.find(
      (doc) =>
        doc.titleNorm === fuzzyTarget ||
        doc.pathNorm === fuzzyTarget ||
        doc.pathNoExt === fuzzyTarget ||
        doc.slug === fuzzyTarget,
    );
    if (fuzzyHit) return { resolved: fuzzyHit, attempts };
  }
  return { resolved: null, attempts };
}

function suggestionFor(rawLink: string, index: DocIndexEntry[]): SuggestedTarget | null {
  const target = normalize(rawLink);
  // Prefer suggesting a path-based form because it's the most stable address.
  // Score by simple character-overlap so we don't add a string-distance dep.
  let best: { entry: DocIndexEntry; score: number } | null = null;
  for (const entry of index) {
    const score = Math.max(commonChars(target, entry.pathNoExt), commonChars(target, entry.slug), commonChars(target, entry.titleNorm));
    if (!best || score > best.score) best = { entry, score };
  }
  if (!best || best.score < target.length * 0.5) return null;
  return {
    target: best.entry.path.replace(/\.md$/i, ""),
    documentId: best.entry.id,
    reason: "Closest path match by character overlap.",
  };
}

function commonChars(a: string, b: string): number {
  let i = 0;
  const min = Math.min(a.length, b.length);
  while (i < min && a[i] === b[i]) i += 1;
  return i;
}

/**
 * F12: linter for an entire workspace. Walks every doc visible to the caller
 * (filtered through buildWorkspaceResolver), parses outbound wikilinks, and
 * reports the ones that don't resolve plus the closest candidate.
 */
export async function lintWikilinks(workspaceId: string, userId: string): Promise<BrokenWikilink[]> {
  const resolver = await buildWorkspaceResolver(userId, workspaceId);
  const allDocs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, folderId: true, title: true, path: true, currentVersionId: true },
  });
  const visible = allDocs.filter((doc) => resolver.documentRole(doc) !== null);
  const index = buildIndex(visible);
  const broken: BrokenWikilink[] = [];
  for (const doc of visible) {
    if (!doc.currentVersionId) continue;
    const revision = await prisma.documentRevision.findUnique({
      where: { id: doc.currentVersionId },
      select: { storageKey: true },
    });
    if (!revision) continue;
    let content: string;
    try {
      content = await readContent(revision.storageKey);
    } catch {
      continue;
    }
    const ctx = documentContext(content);
    for (const link of ctx.wikilinks) {
      if (isLikelyAttachment(link)) continue;
      const { resolved, attempts } = resolveWikilink(link, index);
      if (!resolved) {
        broken.push({
          documentId: doc.id,
          documentTitle: doc.title,
          documentPath: doc.path,
          brokenLink: link,
          attempts,
          suggested: suggestionFor(link, index),
        });
      }
    }
  }
  return broken;
}

function isLikelyAttachment(value: string): boolean {
  return /\.(avif|bmp|gif|heic|jpeg|jpg|mov|mp3|mp4|pdf|png|svg|webm|webp|zip)$/i.test(value.trim());
}

/**
 * F12: workspace-wide find-and-replace on wikilink text. Each replacement
 * matches the exact link content between `[[…]]` brackets. dryRun=true
 * returns the diff preview without writing. dryRun=false writes each
 * affected doc using applyDocumentWrite (with allowNonCanonical=true so
 * cleanup writes can touch superseded docs).
 */
export async function rewriteWikilinks(
  workspaceId: string,
  replacements: RewriteReplacement[],
  dryRun: boolean,
  auth: AuthContext,
): Promise<RewriteResult> {
  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  const docs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, folderId: true, title: true, path: true, currentVersionId: true },
  });
  const writable = docs.filter((doc) => {
    const role = resolver.documentRole(doc);
    return role === "editor" || role === "manager";
  });

  const changes: RewriteOutcomeEntry[] = [];
  for (const doc of writable) {
    if (!doc.currentVersionId) continue;
    const revision = await prisma.documentRevision.findUnique({
      where: { id: doc.currentVersionId },
      select: { storageKey: true },
    });
    if (!revision) continue;
    let content: string;
    try {
      content = await readContent(revision.storageKey);
    } catch {
      continue;
    }

    let next = content;
    let occurrences = 0;
    for (const { from, to } of replacements) {
      const exact = `[[${from}]]`;
      while (next.includes(exact)) {
        next = next.replace(exact, `[[${to}]]`);
        occurrences += 1;
      }
    }
    if (occurrences === 0) {
      changes.push({ documentId: doc.id, documentPath: doc.path, status: "skipped", occurrences: 0 });
      continue;
    }
    if (dryRun) {
      changes.push({ documentId: doc.id, documentPath: doc.path, status: "would_write", occurrences });
      continue;
    }
    const outcome = await applyDocumentWrite({
      documentId: doc.id,
      auth,
      baseVersion: doc.currentVersionId,
      content: next,
      changeSource: "agent",
      // Cleanup writes deliberately target superseded docs too; G8's canonical
      // write guard would otherwise refuse them.
      allowNonCanonical: true,
    });
    if (outcome.ok) {
      changes.push({
        documentId: doc.id,
        documentPath: doc.path,
        status: "written",
        occurrences,
        newVersion: outcome.version,
      });
    } else {
      changes.push({
        documentId: doc.id,
        documentPath: doc.path,
        status: "error",
        occurrences,
        error: outcome.status ?? "unknown",
      });
    }
  }
  return { workspaceId, dryRun, changes };
}

/**
 * F13: format the warning message so authors see (a) what was tried and
 * (b) what target the resolver suggests. Falls back to the legacy "did not
 * resolve" text when no suggestion is available.
 */
export function brokenLinkExplanation(broken: BrokenWikilink): string {
  const attempts = broken.attempts.map((a) => (a.notes ? `${a.step} (${a.notes})` : a.step)).join(", ");
  if (!broken.suggested) {
    return `[[${broken.brokenLink}]] did not resolve. Tried: ${attempts}.`;
  }
  return `[[${broken.brokenLink}]] did not resolve. Tried: ${attempts}. Closest match: [[${broken.suggested.target}]].`;
}
