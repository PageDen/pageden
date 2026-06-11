-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "searchText" TEXT;

-- Full-text index over title + denormalized content for GET /search (active docs only).
CREATE INDEX IF NOT EXISTS "document_search_idx" ON "Document"
  USING GIN (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("searchText", '')))
  WHERE "deletedAt" IS NULL;
