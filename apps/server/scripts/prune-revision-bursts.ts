import { pruneCollapsedRevisions } from "../src/documents/revision-retention.js";
import { prisma } from "../src/prisma.js";
import { sweepOrphanObjects } from "../src/storage.js";

const olderThanMs = Number(process.env.REVISION_PRUNE_AFTER_MS ?? 30 * 24 * 60 * 60 * 1000);
const pruned = await pruneCollapsedRevisions(prisma, { olderThanMs });
const swept = await sweepOrphanObjects(prisma);

console.log(
  `Pruned collapsed revisions: ${pruned.pruned} rows across ${pruned.groupsScanned} groups. ` +
    `Swept orphan storage objects: removed ${swept.removed}, kept ${swept.kept}.`,
);
await prisma.$disconnect();
