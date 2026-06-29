CREATE TABLE "AccountDeletionCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "AccountDeletionCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountDeletionCode_codeHash_key" ON "AccountDeletionCode"("codeHash");
CREATE INDEX "AccountDeletionCode_userId_idx" ON "AccountDeletionCode"("userId");
CREATE INDEX "AccountDeletionCode_expiresAt_idx" ON "AccountDeletionCode"("expiresAt");

ALTER TABLE "AccountDeletionCode" ADD CONSTRAINT "AccountDeletionCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
