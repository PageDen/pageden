-- Phase B: extend WorkspaceRole with two new identity tiers.
--
--   viewer — workspace-wide read-only invariant. Sees every doc/folder as
--            at least viewer; explicit higher grants are capped at viewer
--            by the resolver so a stale manager grant cannot unlock writes
--            after a downgrade.
--   guest  — minimal access. Default-role floors do NOT apply; only
--            explicit per-resource grants count. For external reviewers
--            who should only see what they were specifically invited to.
--
-- ALTER TYPE ADD VALUE is non-transactional in Postgres, so each statement
-- runs on its own. Existing memberships (member/admin) are untouched.
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'viewer';
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'guest';
