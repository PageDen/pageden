import { Prisma } from "@prisma/client";
import type { Role } from "@pageden/api-types";
import { prisma } from "../prisma.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";

export const SEARCH_QUERY_MAX = 256;

const PAGE_MIN = 60;
const PAGE_MAX = 200;
const SCAN_CAP = 1000;
const SHORT_QUERY_BODY_MIN = 3;
const HL_START = "\uE000";
const HL_STOP = "\uE001";

export interface SearchDocumentsResult {
  id: string;
  title: string;
  path: string;
  permission: Role;
  updatedAt: string;
  snippet: string | null;
}

export interface SearchDocumentsOptions {
  userId: string;
  workspaceId: string;
  query: string;
  limit?: number;
}

export function clampSearchLimit(value: unknown, fallback = 20): number {
  const n = typeof value === "number" ? value : Number(value ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 50) : fallback;
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

async function searchCandidatePage({
  workspaceId,
  query,
  limit,
  offset,
}: {
  workspaceId: string;
  query: string;
  limit: number;
  offset: number;
}) {
  const usesBody = query.length >= SHORT_QUERY_BODY_MIN;
  if (usesBody) {
    return prisma.$queryRaw<
      Array<{ id: string; folderId: string; title: string; path: string; updatedAt: Date }>
    >`
      SELECT "id", "folderId", "title", "path", "updatedAt"
      FROM "Document"
      WHERE "workspaceId" = ${workspaceId}
        AND "deletedAt" IS NULL
        AND (
          lower(coalesce("title", '')) LIKE ('%' || lower(${query}) || '%')
          OR lower(coalesce("searchText", '')) LIKE ('%' || lower(${query}) || '%')
        )
      ORDER BY
        (CASE WHEN lower(coalesce("title", '')) LIKE ('%' || lower(${query}) || '%') THEN 0 ELSE 1 END) ASC,
        word_similarity(lower(${query}), lower(coalesce("title", '') || ' ' || coalesce("searchText", ''))) DESC,
        "updatedAt" DESC,
        "id" ASC
      LIMIT ${limit} OFFSET ${offset}`;
  }

  return prisma.$queryRaw<Array<{ id: string; folderId: string; title: string; path: string; updatedAt: Date }>>`
    SELECT "id", "folderId", "title", "path", "updatedAt"
    FROM "Document"
    WHERE "workspaceId" = ${workspaceId}
      AND "deletedAt" IS NULL
      AND lower(coalesce("title", '')) LIKE ('%' || lower(${query}) || '%')
    ORDER BY
      "updatedAt" DESC,
      "id" ASC
    LIMIT ${limit} OFFSET ${offset}`;
}

export async function searchDocuments({
  userId,
  workspaceId,
  query,
  limit = 20,
}: SearchDocumentsOptions): Promise<SearchDocumentsResult[]> {
  const q = query.trim().slice(0, SEARCH_QUERY_MAX);
  if (!q) return [];

  const resolver = await buildWorkspaceResolver(userId, workspaceId);
  const pageSize = Math.min(Math.max(limit * 3, PAGE_MIN), PAGE_MAX);
  const results: Array<Omit<SearchDocumentsResult, "snippet">> = [];
  let offset = 0;

  while (results.length < limit && offset < SCAN_CAP) {
    const rows = await searchCandidatePage({ workspaceId, query: q, limit: pageSize, offset });
    if (rows.length === 0) break;

    for (const doc of rows) {
      const role = resolver.documentRole({ id: doc.id, folderId: doc.folderId });
      if (role !== null) {
        results.push({
          id: doc.id,
          title: doc.title,
          path: doc.path,
          permission: role,
          updatedAt: doc.updatedAt.toISOString(),
        });
        if (results.length >= limit) break;
      }
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  if (results.length === 0) return [];

  const ids = results.map((r) => r.id);
  const bodyRows = await prisma.$queryRaw<Array<{ id: string; searchText: string | null }>>`
    SELECT "id", "searchText" FROM "Document"
    WHERE "id" IN (${Prisma.join(ids)}) AND "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL`;
  const snippetById = new Map(bodyRows.map((r) => [r.id, buildSearchSnippet(r.searchText, q)]));

  return results.map((r) => ({ ...r, snippet: snippetById.get(r.id) ?? null }));
}
