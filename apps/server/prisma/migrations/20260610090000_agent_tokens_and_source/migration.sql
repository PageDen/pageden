ALTER TYPE "ChangeSource" ADD VALUE IF NOT EXISTS 'agent';

ALTER TABLE "ApiToken"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'personal',
  ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['search', 'read', 'create', 'update', 'append', 'attachments']::TEXT[],
  ADD COLUMN "workspaceId" TEXT;

CREATE INDEX "ApiToken_kind_idx" ON "ApiToken"("kind");
CREATE INDEX "ApiToken_workspaceId_idx" ON "ApiToken"("workspaceId");
