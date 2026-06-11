-- Apply these after `prisma migrate dev` generates the initial tables, then re-run migrate.
-- Path uniqueness must ignore soft-deleted rows so a deleted path can be reused (review B4).
-- Prisma cannot express filtered unique indexes, so they live here as raw SQL.

CREATE UNIQUE INDEX IF NOT EXISTS "document_workspace_path_active"
  ON "Document" ("workspaceId", "path")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "folder_workspace_path_active"
  ON "Folder" ("workspaceId", "path")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "document_folder_slug_active"
  ON "Document" ("folderId", "slug")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "folder_workspace_parent_slug_active"
  ON "Folder" ("workspaceId", COALESCE("parentFolderId", ''), "slug")
  WHERE "deletedAt" IS NULL;
