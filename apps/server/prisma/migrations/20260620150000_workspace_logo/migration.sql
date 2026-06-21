-- Cloud-only workspace branding (logo).
ALTER TABLE "Workspace" ADD COLUMN "logoStorageKey" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "logoContentType" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "logoSha" TEXT;
