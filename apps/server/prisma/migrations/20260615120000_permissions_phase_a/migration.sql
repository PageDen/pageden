-- Permission Model Review Phase A: defaultRole + DocumentShare + Permission XOR.
-- See pageden-dev/docs/permission-model-review-outline-docmost.md for the design.

-- A1: per-folder default role floor.
ALTER TABLE "Folder" ADD COLUMN "defaultRole" "PermissionRole";

-- A3: expand Permission with userId / groupId. Read path stays on subjectType/
-- subjectId until the contract step; new writes populate both so the XOR check
-- can be enforced at the DB layer immediately.
ALTER TABLE "Permission"
  ADD COLUMN "userId"  TEXT,
  ADD COLUMN "groupId" TEXT;

UPDATE "Permission" SET "userId"  = "subjectId" WHERE "subjectType" = 'user';
UPDATE "Permission" SET "groupId" = "subjectId" WHERE "subjectType" = 'group';

ALTER TABLE "Permission"
  ADD CONSTRAINT "Permission_user_xor_group_check"
  CHECK (("userId" IS NOT NULL AND "groupId" IS NULL) OR ("userId" IS NULL AND "groupId" IS NOT NULL));

ALTER TABLE "Permission"
  ADD CONSTRAINT "Permission_userId_fkey"  FOREIGN KEY ("userId")  REFERENCES "User"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Permission_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Permission_userId_idx"  ON "Permission"("userId");
CREATE INDEX "Permission_groupId_idx" ON "Permission"("groupId");

-- A2: public share links. One row per share; subtree/folder sharing deferred.
CREATE TABLE "DocumentShare" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "documentId"    TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "passwordHash"  TEXT,
  "allowIndexing" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt"     TIMESTAMP(3),
  "revokedAt"     TIMESTAMP(3),
  "createdById"   TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentShare_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DocumentShare"
  ADD CONSTRAINT "DocumentShare_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentShare_documentId_fkey"  FOREIGN KEY ("documentId")  REFERENCES "Document"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DocumentShare_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id")      ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "DocumentShare_slug_key"                          ON "DocumentShare"("slug");
CREATE INDEX        "DocumentShare_workspaceId_revokedAt_expires_idx" ON "DocumentShare"("workspaceId", "revokedAt", "expiresAt");
CREATE INDEX        "DocumentShare_documentId_revokedAt_idx"          ON "DocumentShare"("documentId", "revokedAt");
