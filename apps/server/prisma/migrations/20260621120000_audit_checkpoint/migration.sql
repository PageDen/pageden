-- Tamper-evidence: global hash-chain checkpoints over the audit log. Cloud-only.
CREATE TABLE "AuditCheckpoint" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "throughCreatedAt" TIMESTAMP(3) NOT NULL,
    "throughId" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    CONSTRAINT "AuditCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditCheckpoint_createdAt_idx" ON "AuditCheckpoint"("createdAt");
