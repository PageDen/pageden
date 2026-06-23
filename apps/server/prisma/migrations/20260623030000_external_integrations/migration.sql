-- Workspace-scoped external integrations and account links for REST/operator clients.
CREATE TABLE "WorkspaceIntegration" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "runtimeMode" TEXT NOT NULL DEFAULT 'rest',
  "name" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientSecretHash" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "WorkspaceIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceIntegration_clientId_key"
  ON "WorkspaceIntegration"("clientId");

CREATE INDEX "WorkspaceIntegration_workspaceId_idx"
  ON "WorkspaceIntegration"("workspaceId");

CREATE INDEX "WorkspaceIntegration_providerKey_idx"
  ON "WorkspaceIntegration"("providerKey");

CREATE INDEX "WorkspaceIntegration_runtimeMode_idx"
  ON "WorkspaceIntegration"("runtimeMode");

CREATE INDEX "WorkspaceIntegration_revokedAt_idx"
  ON "WorkspaceIntegration"("revokedAt");

ALTER TABLE "WorkspaceIntegration"
  ADD CONSTRAINT "WorkspaceIntegration_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceIntegration"
  ADD CONSTRAINT "WorkspaceIntegration_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ExternalAccountLink" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "externalProvider" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "externalUsername" TEXT,
  "externalMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "ExternalAccountLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalAccountLink_integrationId_externalProvider_externalAccountId_key"
  ON "ExternalAccountLink"("integrationId", "externalProvider", "externalAccountId");

CREATE INDEX "ExternalAccountLink_workspaceId_userId_idx"
  ON "ExternalAccountLink"("workspaceId", "userId");

CREATE INDEX "ExternalAccountLink_integrationId_revokedAt_idx"
  ON "ExternalAccountLink"("integrationId", "revokedAt");

ALTER TABLE "ExternalAccountLink"
  ADD CONSTRAINT "ExternalAccountLink_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalAccountLink"
  ADD CONSTRAINT "ExternalAccountLink_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "WorkspaceIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalAccountLink"
  ADD CONSTRAINT "ExternalAccountLink_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExternalConnectSession" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "externalProvider" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "externalUsername" TEXT,
  "externalMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),

  CONSTRAINT "ExternalConnectSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalConnectSession_tokenHash_key"
  ON "ExternalConnectSession"("tokenHash");

CREATE INDEX "ExternalConnectSession_integrationId_externalProvider_externalAccountId_idx"
  ON "ExternalConnectSession"("integrationId", "externalProvider", "externalAccountId");

CREATE INDEX "ExternalConnectSession_expiresAt_idx"
  ON "ExternalConnectSession"("expiresAt");

ALTER TABLE "ExternalConnectSession"
  ADD CONSTRAINT "ExternalConnectSession_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalConnectSession"
  ADD CONSTRAINT "ExternalConnectSession_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "WorkspaceIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
