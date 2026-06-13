-- The original FTS index was not used by the substring search query, but still
-- had to be maintained on every document write. Replace it with trigram indexes
-- that support the current LIKE-based search semantics.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS "document_search_idx";

CREATE INDEX IF NOT EXISTS "Document_title_trgm_idx" ON "Document"
  USING GIN (lower(coalesce("title", '')) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Document_searchText_trgm_idx" ON "Document"
  USING GIN (lower(coalesce("searchText", '')) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;
