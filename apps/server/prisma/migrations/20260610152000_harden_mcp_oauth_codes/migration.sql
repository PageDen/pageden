ALTER TABLE "McpOAuthCode" ADD COLUMN "codeHash" TEXT;
ALTER TABLE "McpOAuthCode" ADD COLUMN "codeChallenge" TEXT;

CREATE UNIQUE INDEX "McpOAuthCode_codeHash_key" ON "McpOAuthCode"("codeHash");
