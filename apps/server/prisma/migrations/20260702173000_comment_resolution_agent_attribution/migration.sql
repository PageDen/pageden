ALTER TABLE "DocumentComment"
  ADD COLUMN "resolvedByTokenId" TEXT,
  ADD COLUMN "resolvedByLabel" TEXT;

ALTER TABLE "DocumentComment"
  ADD CONSTRAINT "DocumentComment_resolvedByTokenId_fkey"
  FOREIGN KEY ("resolvedByTokenId") REFERENCES "ApiToken"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
