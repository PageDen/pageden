-- Cloud-only: per-member read access to the workspace Audit Log.
ALTER TABLE "WorkspaceMembership" ADD COLUMN "canViewAudit" BOOLEAN NOT NULL DEFAULT false;
