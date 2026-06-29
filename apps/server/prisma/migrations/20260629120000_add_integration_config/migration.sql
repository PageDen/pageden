-- Self-hosted: add WorkspaceIntegration.config (used by integration REST actions,
-- e.g. allowedFolders). Authored fresh for the public repo rather than importing
-- the coupled cloud migration chain.
ALTER TABLE "WorkspaceIntegration" ADD COLUMN "config" JSONB;
