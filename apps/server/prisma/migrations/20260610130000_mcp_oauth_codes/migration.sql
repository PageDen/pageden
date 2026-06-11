CREATE TABLE "McpOAuthCode" (
  "id" TEXT NOT NULL,
  "jti" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "McpOAuthCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpOAuthCode_jti_key" ON "McpOAuthCode"("jti");
CREATE INDEX "McpOAuthCode_expiresAt_idx" ON "McpOAuthCode"("expiresAt");
CREATE INDEX "McpOAuthCode_userId_idx" ON "McpOAuthCode"("userId");
CREATE INDEX "McpOAuthCode_workspaceId_idx" ON "McpOAuthCode"("workspaceId");

ALTER TABLE "McpOAuthCode"
  ADD CONSTRAINT "McpOAuthCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "McpOAuthCode"
  ADD CONSTRAINT "McpOAuthCode_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
