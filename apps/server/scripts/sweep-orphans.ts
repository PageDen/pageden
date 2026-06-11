import { sweepOrphanObjects } from "../src/storage.js";
import { prisma } from "../src/prisma.js";

// One-off maintenance: delete content objects and attachment blobs no live row references
// (older than 1h).
const result = await sweepOrphanObjects(prisma);
console.log(`Swept orphan storage objects: removed ${result.removed}, kept ${result.kept}.`);
await prisma.$disconnect();
