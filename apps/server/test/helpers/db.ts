import { prisma } from "../../src/prisma.js";

const TABLES = [
  "AuditEvent",
  "McpOAuthCode",
  "DeviceAuthRequest",
  "DocumentRevision",
  "Document",
  "Folder",
  "Permission",
  "GroupMembership",
  "Group",
  "WorkspaceMembership",
  "ApiToken",
  "User",
  "Workspace",
];

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(",")} RESTART IDENTITY CASCADE`,
  );
}

export { prisma };
