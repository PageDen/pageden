import { prisma } from "../prisma.js";
import { readContent } from "../storage.js";
import { documentContext } from "../ai-readiness.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import { extractPrLinks } from "./handoff.js";

export interface DocumentRef {
  id: string;
  title: string;
  path: string;
  status: string;
}

export interface DocumentRelationships {
  documentId: string;
  workspaceId: string;
  supersedes: DocumentRef[];
  supersededBy: DocumentRef | null;
  references: DocumentRef[];
  referencedBy: DocumentRef[];
  prLinks: string[];
}

function normalize(target: string): string {
  return target
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .toLowerCase();
}

function tokensForDoc(doc: { title: string; path: string }): string[] {
  // Aliases an inbound link can use to address this document. Match the
  // wikilink/markdown-link forms we render in the editor: title, full path,
  // path-without-extension, and the trailing filename.
  const filename = doc.path.split("/").pop() ?? "";
  return [doc.title, doc.path, doc.path.replace(/\.md$/i, ""), filename.replace(/\.md$/i, "")]
    .filter(Boolean)
    .map(normalize);
}

function extractMarkdownLinkTargets(body: string): string[] {
  const set = new Set<string>();
  // Markdown links to internal paths: [title](some/path) or [title](some/path.md).
  for (const match of body.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const href = (match[2] ?? "").trim();
    if (!href || /^[a-z][a-z+\-.]*:/.test(href) || href.startsWith("#")) continue;
    set.add(href);
  }
  return [...set];
}

async function readDocBody(documentId: string, currentVersionId: string | null): Promise<string> {
  if (!currentVersionId) return "";
  const revision = await prisma.documentRevision.findUnique({
    where: { id: currentVersionId },
    select: { storageKey: true },
  });
  if (!revision) return "";
  try {
    return await readContent(revision.storageKey);
  } catch {
    return "";
  }
}

const RELATIONSHIP_DOC_CAP = 250;

/**
 * Build the typed relationship panel for a document: forward supersession,
 * outbound references via wikilinks/markdown links, inbound backlinks, the PR
 * links parsed from frontmatter, and the previously-superseded link. All
 * results are filtered through the workspace resolver so private docs the
 * caller cannot see never appear.
 */
export async function documentRelationships(
  userId: string,
  documentId: string,
): Promise<DocumentRelationships | null> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      path: true,
      currentVersionId: true,
      supersededById: true,
    },
  });
  if (!doc) return null;

  const resolver = await buildWorkspaceResolver(userId, doc.workspaceId);

  // Pull the workspace's docs once so we can resolve link targets and compute
  // backlinks in one pass instead of N round trips. Visibility for THIS doc
  // is already guarded by the calling route — we only need the resolver to
  // filter the link targets we expose to the caller.
  const allDocs = await prisma.document.findMany({
    where: { workspaceId: doc.workspaceId, deletedAt: null },
    select: { id: true, folderId: true, title: true, path: true, status: true, supersededById: true, currentVersionId: true },
  });
  const visibleDocs = allDocs.filter((other) => resolver.documentRole(other) !== null);

  const targetMap = new Map<string, typeof visibleDocs[number]>();
  for (const other of visibleDocs) {
    for (const token of tokensForDoc(other)) targetMap.set(token, other);
  }

  function asRef(other: typeof visibleDocs[number]): DocumentRef {
    return { id: other.id, title: other.title, path: other.path, status: other.status };
  }

  // Forward supersession: other docs flagged "I am superseded by THIS doc".
  const supersedes = visibleDocs.filter((other) => other.supersededById === doc.id && other.id !== doc.id).map(asRef);
  // Backward supersession: the single doc this one was superseded by.
  const supersededBy = doc.supersededById
    ? visibleDocs.find((other) => other.id === doc.supersededById) ?? null
    : null;

  // Outbound references: parse the current body and resolve link targets.
  const body = await readDocBody(doc.id, doc.currentVersionId);
  const ctx = documentContext(body);
  const targets = [...ctx.wikilinks, ...extractMarkdownLinkTargets(ctx.body)];
  const references = new Map<string, DocumentRef>();
  for (const target of targets) {
    const hit = targetMap.get(normalize(target));
    if (hit && hit.id !== doc.id) references.set(hit.id, asRef(hit));
  }

  // Inbound references (backlinks): scan the bodies of OTHER docs for any
  // token that points at this doc. Cap the scan at RELATIONSHIP_DOC_CAP to
  // bound latency on huge workspaces.
  const selfTokens = new Set(tokensForDoc(doc));
  const referencedBy = new Map<string, DocumentRef>();
  const scanCandidates = visibleDocs.filter((other) => other.id !== doc.id).slice(0, RELATIONSHIP_DOC_CAP);
  for (const other of scanCandidates) {
    const otherBody = await readDocBody(other.id, other.currentVersionId);
    if (!otherBody) continue;
    const otherCtx = documentContext(otherBody);
    const otherTargets = [...otherCtx.wikilinks, ...extractMarkdownLinkTargets(otherCtx.body)].map(normalize);
    if (otherTargets.some((target) => selfTokens.has(target))) {
      referencedBy.set(other.id, asRef(other));
    }
  }

  const prLinks = extractPrLinks(ctx.body, ctx.frontmatter);

  return {
    documentId: doc.id,
    workspaceId: doc.workspaceId,
    supersedes,
    supersededBy: supersededBy ? asRef(supersededBy) : null,
    references: [...references.values()].sort((a, b) => a.path.localeCompare(b.path)),
    referencedBy: [...referencedBy.values()].sort((a, b) => a.path.localeCompare(b.path)),
    prLinks,
  };
}
