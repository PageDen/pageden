CREATE TABLE "McpOAuthClient" (
  "id" TEXT NOT NULL,
  "redirectUris" TEXT[],
  "clientName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "McpOAuthCode" ALTER COLUMN "workspaceId" DROP NOT NULL;
