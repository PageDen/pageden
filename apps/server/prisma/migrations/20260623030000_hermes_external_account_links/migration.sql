-- External platform account links for Hermes delegated PageDen access.
CREATE TABLE "ExternalAccountLink" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "providerUsername" TEXT,
  "providerMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "ExternalAccountLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalAccountLink_provider_providerAccountId_key"
  ON "ExternalAccountLink"("provider", "providerAccountId");

CREATE INDEX "ExternalAccountLink_userId_idx"
  ON "ExternalAccountLink"("userId");

CREATE INDEX "ExternalAccountLink_provider_providerAccountId_idx"
  ON "ExternalAccountLink"("provider", "providerAccountId");

ALTER TABLE "ExternalAccountLink"
  ADD CONSTRAINT "ExternalAccountLink_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Short-lived browser handoff sessions for /pageden connect.
CREATE TABLE "HermesConnectSession" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "providerUsername" TEXT,
  "providerMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),

  CONSTRAINT "HermesConnectSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HermesConnectSession_tokenHash_key"
  ON "HermesConnectSession"("tokenHash");

CREATE INDEX "HermesConnectSession_provider_providerAccountId_idx"
  ON "HermesConnectSession"("provider", "providerAccountId");

CREATE INDEX "HermesConnectSession_expiresAt_idx"
  ON "HermesConnectSession"("expiresAt");
