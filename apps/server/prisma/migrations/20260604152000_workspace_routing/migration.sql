-- Add workspace URL routing fields.
ALTER TABLE "Workspace" ADD COLUMN "subdomain" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "customDomain" TEXT;

CREATE UNIQUE INDEX "Workspace_subdomain_key" ON "Workspace"("subdomain");
CREATE UNIQUE INDEX "Workspace_customDomain_key" ON "Workspace"("customDomain");
