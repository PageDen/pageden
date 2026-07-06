import { Prisma, type DocumentStatus } from "@prisma/client";
import type { Role } from "@pageden/api-types";
import { prisma } from "../prisma.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";

export const SEARCH_QUERY_MAX = 256;

const PAGE_MIN = 60;
const PAGE_MAX = 200;
const SCAN_CAP = 1000;
const SHORT_QUERY_BODY_MIN = 3;
const QUERY_TOKEN_MIN = 3;
const QUERY_TOKEN_MAX = 10;
const HL_START = "\uE000";
const HL_STOP = "\uE001";

const QUERY_STOP_WORDS = new Set([
  "about",
  "ang",
  "are",
  "company",
  "document",
  "docs",
  "for",
  "from",
  "how",
  "man",
  "nga",
  "please",
  "the",
  "this",
  "unsa",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export interface SearchDocumentsResult {
  id: string;
  title: string;
  path: string;
  permission: Role;
  status: DocumentStatus;
  updatedAt: string;
  snippet: string | null;
}

export interface SearchDocumentsOptions {
  userId: string;
  workspaceId: string;
  query: string;
  limit?: number;
  // When true, only canonical docs are returned. Otherwise all four statuses are
  // ranked canonical > draft > superseded > archived after title-match precedence
  // so an agent's first hit is always the current source of truth.
  canonicalOnly?: boolean;
}

export function clampSearchLimit(value: unknown, fallback = 20): number {
  const n = typeof value === "number" ? value : Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 50) : fallback;
}

function isQueryTokenChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function searchQueryVariants(query: string): string[] {
  const variants = [query];
  const seen = new Set(variants.map((v) => v.toLowerCase()));
  let token = "";

  function addToken() {
    if (token.length >= QUERY_TOKEN_MIN && !QUERY_STOP_WORDS.has(token) && !seen.has(token)) {
      variants.push(token);
      seen.add(token);
    }
    token = "";
  }

  for (let i = 0; i < query.length; i += 1) {
    const code = query.charCodeAt(i);
    if (isQueryTokenChar(code)) {
      token += query[i]!.toLowerCase();
    } else {
      addToken();
    }
  }
  addToken();

  return variants.slice(0, QUERY_TOKEN_MAX);
}

function wordPatternForQuery(query: string): string | null {
  if (query.length < QUERY_TOKEN_MIN) return null;
  for (let i = 0; i < query.length; i += 1) {
    if (!isQueryTokenChar(query.charCodeAt(i))) return null;
  }
  return `(^|[^[:alnum:]])${query.toLowerCase()}([^[:alnum:]]|$)`;
}

// Build a short excerpt around the first case-insensitive occurrence of `q` in the body, with the
// match wrapped in the highlight markers. Returns null when the term isn't in the body (e.g. the
// document only matched on its title).
export function buildSearchSnippet(searchText: string | null, q: string): string | null {
  if (!searchText) return null;
  const idx = searchText.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return null;
  const RADIUS = 60;
  const start = Math.max(0, idx - RADIUS);
  const end = Math.min(searchText.length, idx + q.length + RADIUS);
  const before = searchText.slice(start, idx);
  const match = searchText.slice(idx, idx + q.length);
  const after = searchText.slice(idx + q.length, end);
  let frag = `${before}${HL_START}${match}${HL_STOP}${after}`.replace(/\s+/g, " ").trim();
  if (start > 0) frag = `... ${frag}`;
  if (end < searchText.length) frag = `${frag} ...`;
  return frag;
}

type Candidate = { id: string; folderId: string; title: string; path: string; status: DocumentStatus; updatedAt: Date };

async function searchCandidatePage({
  workspaceId,
  query,
  limit,
  offset,
  canonicalOnly,
}: {
  workspaceId: string;
  query: string;
  limit: number;
  offset: number;
  canonicalOnly: boolean;
}): Promise<Candidate[]> {
  const usesBody = query.length >= SHORT_QUERY_BODY_MIN;
  const wordPattern = wordPatternForQuery(query);
  if (usesBody) {
    return prisma.$queryRaw<Candidate[]>`
      SELECT "id", "folderId", "title", "path", "status", "updatedAt"
      FROM "Document"
      WHERE "workspaceId" = ${workspaceId}
        AND "deletedAt" IS NULL
        AND (NOT ${canonicalOnly} OR "status" = 'canonical')
        AND (
          lower(coalesce("title", '')) LIKE ('%' || lower(${query}) || '%')
          OR lower(coalesce("path", '')) LIKE ('%' || lower(${query}) || '%')
          OR lower(coalesce("searchText", '')) LIKE ('%' || lower(${query}) || '%')
        )
      ORDER BY
        (CASE
          WHEN ${wordPattern}::text IS NOT NULL AND lower(coalesce("title", '')) ~ ${wordPattern} THEN 0
          WHEN ${wordPattern}::text IS NOT NULL AND lower(coalesce("path", '')) ~ ${wordPattern} THEN 1
          WHEN lower(coalesce("title", '')) LIKE ('%' || lower(${query}) || '%') THEN 2
          WHEN lower(coalesce("path", '')) LIKE ('%' || lower(${query}) || '%') THEN 3
          ELSE 4
        END) ASC,
        (CASE "status" WHEN 'canonical' THEN 0 WHEN 'draft' THEN 1 WHEN 'superseded' THEN 2 ELSE 3 END) ASC,
        word_similarity(lower(${query}), lower(coalesce("title", '') || ' ' || coalesce("path", '') || ' ' || coalesce("searchText", ''))) DESC,
        "updatedAt" DESC,
        "id" ASC
      LIMIT ${limit} OFFSET ${offset}`;
  }

  return prisma.$queryRaw<Candidate[]>`
    SELECT "id", "folderId", "title", "path", "status", "updatedAt"
    FROM "Document"
    WHERE "workspaceId" = ${workspaceId}
      AND "deletedAt" IS NULL
      AND (NOT ${canonicalOnly} OR "status" = 'canonical')
      AND lower(coalesce("title", '')) LIKE ('%' || lower(${query}) || '%')
    ORDER BY
      (CASE "status" WHEN 'canonical' THEN 0 WHEN 'draft' THEN 1 WHEN 'superseded' THEN 2 ELSE 3 END) ASC,
      "updatedAt" DESC,
      "id" ASC
    LIMIT ${limit} OFFSET ${offset}`;
}

export async function searchDocuments({
  userId,
  workspaceId,
  query,
  limit = 20,
  canonicalOnly = false,
}: SearchDocumentsOptions): Promise<SearchDocumentsResult[]> {
  const q = query.trim().slice(0, SEARCH_QUERY_MAX);
  if (!q) return [];

  const resolver = await buildWorkspaceResolver(userId, workspaceId);
  const pageSize = Math.min(Math.max(limit * 3, PAGE_MIN), PAGE_MAX);
  const results: Array<Omit<SearchDocumentsResult, "snippet"> & { matchedQuery: string }> = [];
  const seenIds = new Set<string>();

  for (const searchQuery of searchQueryVariants(q)) {
    let offset = 0;

    while (results.length < limit && offset < SCAN_CAP) {
      const rows = await searchCandidatePage({ workspaceId, query: searchQuery, limit: pageSize, offset, canonicalOnly });
      if (rows.length === 0) break;

      for (const doc of rows) {
        if (seenIds.has(doc.id)) continue;
        const role = resolver.documentRole({ id: doc.id, folderId: doc.folderId });
        if (role !== null) {
          seenIds.add(doc.id);
          results.push({
            id: doc.id,
            title: doc.title,
            path: doc.path,
            permission: role,
            status: doc.status,
            updatedAt: doc.updatedAt.toISOString(),
            matchedQuery: searchQuery,
          });
          if (results.length >= limit) break;
        }
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    if (results.length >= limit) break;
  }

  if (results.length === 0) return [];

  const ids = results.map((r) => r.id);
  const bodyRows = await prisma.$queryRaw<Array<{ id: string; searchText: string | null }>>`
    SELECT "id", "searchText" FROM "Document"
    WHERE "id" IN (${Prisma.join(ids)}) AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL`;
  const matchedQueryById = new Map(results.map((r) => [r.id, r.matchedQuery]));
  const snippetById = new Map(bodyRows.map((r) => [r.id, buildSearchSnippet(r.searchText, matchedQueryById.get(r.id) ?? q)]));

  return results.map(({ matchedQuery: _matchedQuery, ...r }) => ({ ...r, snippet: snippetById.get(r.id) ?? null }));
}
