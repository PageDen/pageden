-- Add first-run onboarding marker.
ALTER TABLE "User" ADD COLUMN "onboardedAt" TIMESTAMP(3);

-- Backfill existing users as already onboarded (use their creation time) so the
-- new onboarding redirect only catches accounts created from here on.
UPDATE "User" SET "onboardedAt" = "createdAt" WHERE "onboardedAt" IS NULL;
