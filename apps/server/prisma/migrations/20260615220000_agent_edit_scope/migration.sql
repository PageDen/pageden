-- Phase C2: agent edit scope.
--
-- A workspace admin can pin agent token writes to a single folder subtree.
-- When `agentEditScopeFolderId` is NULL (default), agent tokens write anywhere
-- they have permission, which is the historical behavior.
-- When set, agent tokens can only WRITE inside that folder (and its
-- descendants). Read paths are unaffected — agents can still search and
-- read across the workspace.
--
-- ON DELETE SET NULL so deleting the scope folder degrades safely back to
-- the "agents can write anywhere" default rather than leaving a dangling FK.
ALTER TABLE "Workspace" ADD COLUMN "agentEditScopeFolderId" TEXT;

ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_agentEditScopeFolderId_fkey"
  FOREIGN KEY ("agentEditScopeFolderId") REFERENCES "Folder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Workspace_agentEditScopeFolderId_idx"
  ON "Workspace"("agentEditScopeFolderId");
