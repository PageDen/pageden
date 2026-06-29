CREATE TABLE "DocumentCommentMention" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "commentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DocumentCommentMention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentCommentMention_commentId_userId_key"
  ON "DocumentCommentMention"("commentId", "userId");

CREATE INDEX "DocumentCommentMention_documentId_userId_idx"
  ON "DocumentCommentMention"("documentId", "userId");

CREATE INDEX "DocumentCommentMention_workspaceId_userId_idx"
  ON "DocumentCommentMention"("workspaceId", "userId");

ALTER TABLE "DocumentCommentMention"
  ADD CONSTRAINT "DocumentCommentMention_commentId_fkey"
  FOREIGN KEY ("commentId") REFERENCES "DocumentComment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocumentCommentMention"
  ADD CONSTRAINT "DocumentCommentMention_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
