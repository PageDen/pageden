-- Phase 1: first-class canonical/superseded metadata on Document.
-- Existing rows are treated as `canonical` so search ranking and the
-- superseded-banner UI behave exactly as before until an editor opts a
-- document into a different status via frontmatter.

CREATE TYPE "DocumentStatus" AS ENUM ('canonical', 'draft', 'superseded', 'archived');

ALTER TABLE "Document"
  ADD COLUMN "status" "DocumentStatus" NOT NULL DEFAULT 'canonical',
  ADD COLUMN "supersededById" TEXT;

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "Document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Document_workspaceId_status_idx" ON "Document"("workspaceId", "status");
CREATE INDEX "Document_supersededById_idx" ON "Document"("supersededById");
