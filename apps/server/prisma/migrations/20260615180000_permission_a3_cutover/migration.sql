-- Phase A3 cutover: drop the legacy (subjectType, subjectId) discriminator
-- columns now that the read path goes through userId / groupId. The XOR
-- check + backfill landed in 20260615120000_permissions_phase_a; every
-- existing row already has the new columns populated.

-- Replace the (workspaceId, subjectType, subjectId, resourceType, resourceId)
-- unique constraint with two partial unique indexes — one for user rows,
-- one for group rows — so each (user|group, resource) pair appears at most
-- once without conflicting with the XOR check (which makes the OTHER side null).
DROP INDEX IF EXISTS "Permission_workspaceId_subjectType_subjectId_resourceType_re_key";
DROP INDEX IF EXISTS "Permission_workspaceId_subjectType_subjectId_idx";

CREATE UNIQUE INDEX "Permission_workspaceId_userId_resourceType_resourceId_key"
  ON "Permission"("workspaceId", "userId", "resourceType", "resourceId")
  WHERE "userId" IS NOT NULL;

CREATE UNIQUE INDEX "Permission_workspaceId_groupId_resourceType_resourceId_key"
  ON "Permission"("workspaceId", "groupId", "resourceType", "resourceId")
  WHERE "groupId" IS NOT NULL;

ALTER TABLE "Permission" DROP COLUMN "subjectType";
ALTER TABLE "Permission" DROP COLUMN "subjectId";

-- PermissionSubjectType enum is no longer used by any column; drop it so the
-- Prisma client matches the schema. Done as the last step so the column drop
-- doesn't refuse on a dependency.
DROP TYPE IF EXISTS "PermissionSubjectType";
