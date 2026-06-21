-- Cloud-only audit-log retention (days). null = use cloud default, 0 = keep forever.
ALTER TABLE "Workspace" ADD COLUMN "auditRetentionDays" INTEGER;
