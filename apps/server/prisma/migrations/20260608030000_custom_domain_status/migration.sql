CREATE TYPE "CustomDomainStatus" AS ENUM ('pending', 'verified', 'active', 'failed');

ALTER TABLE "Workspace" ADD COLUMN "customDomainStatus" "CustomDomainStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "customDomainVerifiedAt" TIMESTAMP(3);
