ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "publicSharingEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "DocumentShare"
  ALTER COLUMN "documentId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "folderId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DocumentShare_folderId_fkey'
  ) THEN
    ALTER TABLE "DocumentShare"
      ADD CONSTRAINT "DocumentShare_folderId_fkey"
      FOREIGN KEY ("folderId") REFERENCES "Folder"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DocumentShare_target_xor'
  ) THEN
    ALTER TABLE "DocumentShare"
      ADD CONSTRAINT "DocumentShare_target_xor"
      CHECK (
        ("documentId" IS NOT NULL AND "folderId" IS NULL)
        OR
        ("documentId" IS NULL AND "folderId" IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DocumentShare_folderId_revokedAt_idx"
  ON "DocumentShare"("folderId", "revokedAt");
