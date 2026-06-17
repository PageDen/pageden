import { documentReadablePath } from "../../lib/document-links";
import { headingId } from "./table-of-contents";

export interface DocumentLinkTarget {
  title: string;
  path: string;
}

export interface DocumentLinkTree {
  documents: DocumentLinkTarget[];
}

export function relatedDocLinksForValue(
  value: string | string[] | boolean | number,
  workspaceId: string,
  tree?: DocumentLinkTree,
): Array<{ target: string; label: string; href: string | null }> {
  const values = Array.isArray(value) ? value : [String(value)];
  return values.flatMap((item) => {
    const links = extractWikiLinkTargets(String(item));
    if (links.length === 0) return [];
    return links.map(({ target, label }) => {
      const doc = findDocumentForWikiTarget(target, tree);
      return {
        target,
        label: label || doc?.title || target,
        href: doc ? documentReadablePath(workspaceId, doc.path) : null,
      };
    });
  });
}

export function resolveWikiLinks(content: string, workspaceId: string, tree?: DocumentLinkTree): string {
  return content
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, rawTarget: string, rawLabel?: string) => {
      const { target, label } = parseWikiTarget(rawTarget, rawLabel);
      return `![${label}](${target})`;
    })
    .replace(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, rawTarget: string, rawLabel?: string) => {
      const { target, heading, label } = parseWikiTarget(rawTarget, rawLabel);
      if (!target && heading) return `[${label}](#${headingId(heading)})`;
      const doc = findDocumentForWikiTarget(target, tree);
      if (!doc) return label;
      const hash = heading ? `#${headingId(heading)}` : "";
      return `[${label}](${documentReadablePath(workspaceId, doc.path)}${hash})`;
    });
}

function extractWikiLinkTargets(value: string): Array<{ target: string; label: string }> {
  const links: Array<{ target: string; label: string }> = [];
  for (const match of value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?]]/g)) {
    const target = match[1]?.trim();
    if (!target) continue;
    links.push({ target, label: match[2]?.trim() || target });
  }
  return links;
}

function findDocumentForWikiTarget(target: string, tree?: DocumentLinkTree): DocumentLinkTarget | undefined {
  const normalized = normalizeWikiLookup(target);
  return (tree?.documents ?? []).find((doc) => {
    const filename = doc.path.split("/").pop() ?? "";
    return [
      doc.title,
      doc.path,
      doc.path.replace(/\.md$/i, ""),
      filename.replace(/\.md$/i, ""),
    ].some((candidate) => normalizeWikiLookup(candidate) === normalized);
  });
}

function parseWikiTarget(rawTarget: string, rawLabel?: string) {
  const value = rawTarget.trim();
  const [targetPart = "", ...headingParts] = value.split("#");
  const target = targetPart.trim();
  const heading = headingParts.join("#").trim();
  const label = (rawLabel ?? (heading || target)).trim();
  return { target, heading, label };
}

function normalizeWikiLookup(value: string): string {
  return value.trim().replace(/^\/+/, "").replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
}
