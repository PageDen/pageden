ALTER TABLE "DocumentRevision" ADD COLUMN "revisionGroupId" TEXT;

CREATE INDEX "DocumentRevision_documentId_revisionGroupId_versionNumber_idx"
  ON "DocumentRevision"("documentId", "revisionGroupId", "versionNumber");
