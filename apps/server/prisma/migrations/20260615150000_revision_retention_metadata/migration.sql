ALTER TABLE "DocumentRevision"
  ADD COLUMN "contributorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "label" TEXT,
  ADD COLUMN "prunedAt" TIMESTAMP(3);

UPDATE "DocumentRevision"
SET "contributorIds" = ARRAY["createdById"]
WHERE cardinality("contributorIds") = 0;

CREATE INDEX "DocumentRevision_documentId_prunedAt_idx" ON "DocumentRevision"("documentId", "prunedAt");
