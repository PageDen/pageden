-- Phase 3.2/3.3 + Phase 4.2 + Phase 4.3: inline comments, read cursors, claims.

-- Inline comments. authorTokenId is nullable so a web user can author one;
-- authorUserId is nullable so an agent can. authorLabel is captured at write
-- time so a deleted/revoked token's comments still show "Codex (revoked)".
CREATE TABLE "DocumentComment" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "documentId"    TEXT NOT NULL,
  "sectionAnchor" TEXT,
  "authorUserId"  TEXT,
  "authorTokenId" TEXT,
  "authorLabel"   TEXT,
  "body"          TEXT NOT NULL,
  "resolvedAt"    TIMESTAMP(3),
  "resolvedById"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentComment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DocumentComment"
  ADD CONSTRAINT "DocumentComment_workspaceId_fkey"   FOREIGN KEY ("workspaceId")   REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentComment_documentId_fkey"    FOREIGN KEY ("documentId")    REFERENCES "Document"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentComment_authorUserId_fkey"  FOREIGN KEY ("authorUserId")  REFERENCES "User"("id")      ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentComment_authorTokenId_fkey" FOREIGN KEY ("authorTokenId") REFERENCES "ApiToken"("id")  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentComment_resolvedById_fkey"  FOREIGN KEY ("resolvedById")  REFERENCES "User"("id")      ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "DocumentComment_documentId_resolvedAt_idx"  ON "DocumentComment"("documentId", "resolvedAt");
CREATE INDEX "DocumentComment_workspaceId_resolvedAt_idx" ON "DocumentComment"("workspaceId", "resolvedAt");

-- Per-token (or per-user) read cursor. The two partial unique indexes make sure
-- each (tokenId, documentId) and (userId, documentId) pair appears at most once
-- but allow many rows to share NULL tokenId/userId, which is the upsert pattern
-- our code uses (one side is always populated, never both).
CREATE TABLE "TokenReadCursor" (
  "id"              TEXT NOT NULL,
  "tokenId"         TEXT,
  "userId"          TEXT,
  "workspaceId"     TEXT NOT NULL,
  "documentId"      TEXT NOT NULL,
  "lastReadVersion" TEXT,
  "lastReadAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TokenReadCursor_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TokenReadCursor"
  ADD CONSTRAINT "TokenReadCursor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TokenReadCursor_documentId_fkey"  FOREIGN KEY ("documentId")  REFERENCES "Document"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TokenReadCursor_tokenId_fkey"     FOREIGN KEY ("tokenId")     REFERENCES "ApiToken"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "TokenReadCursor_userId_fkey"      FOREIGN KEY ("userId")      REFERENCES "User"("id")      ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "TokenReadCursor_tokenId_documentId_key" ON "TokenReadCursor"("tokenId", "documentId");
CREATE UNIQUE INDEX "TokenReadCursor_userId_documentId_key"  ON "TokenReadCursor"("userId", "documentId");
CREATE INDEX "TokenReadCursor_workspaceId_lastReadAt_idx"    ON "TokenReadCursor"("workspaceId", "lastReadAt");

-- Soft document claims. Not a write lock; the dashboard renders active claims
-- so concurrent agents can coordinate. expiresAt is required so a crashed
-- agent's claim auto-frees rather than blocking the doc forever.
CREATE TABLE "DocumentClaim" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "documentId"  TEXT NOT NULL,
  "tokenId"     TEXT,
  "userId"      TEXT,
  "actorLabel"  TEXT,
  "note"        TEXT,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "releasedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentClaim_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DocumentClaim"
  ADD CONSTRAINT "DocumentClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentClaim_documentId_fkey"  FOREIGN KEY ("documentId")  REFERENCES "Document"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentClaim_tokenId_fkey"     FOREIGN KEY ("tokenId")     REFERENCES "ApiToken"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentClaim_userId_fkey"      FOREIGN KEY ("userId")      REFERENCES "User"("id")      ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "DocumentClaim_workspaceId_releasedAt_expiresAt_idx" ON "DocumentClaim"("workspaceId", "releasedAt", "expiresAt");
CREATE INDEX "DocumentClaim_documentId_releasedAt_expiresAt_idx"  ON "DocumentClaim"("documentId", "releasedAt", "expiresAt");
