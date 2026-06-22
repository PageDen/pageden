-- Email-domain allowlist per workspace. Empty list = subdomain self-join off.
-- PR 1: table + helpers only; enforcement (cloud subdomain self-join) lands later.
CREATE TABLE "WorkspaceAllowedEmailDomain" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceAllowedEmailDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceAllowedEmailDomain_workspaceId_domain_key" ON "WorkspaceAllowedEmailDomain"("workspaceId", "domain");

CREATE INDEX "WorkspaceAllowedEmailDomain_workspaceId_idx" ON "WorkspaceAllowedEmailDomain"("workspaceId");

ALTER TABLE "WorkspaceAllowedEmailDomain" ADD CONSTRAINT "WorkspaceAllowedEmailDomain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceAllowedEmailDomain" ADD CONSTRAINT "WorkspaceAllowedEmailDomain_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
