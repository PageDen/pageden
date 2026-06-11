import { canonicalize } from "../src/checksum.js";
import { prisma } from "../src/prisma.js";
import { readContent } from "../src/storage.js";

// One-off migration helper: populate Document.searchText for documents created before the
// full-text-search milestone. New writes (create/update/push/restore) set searchText inline,
// so this only needs to run once after deploying the search column. It reads each live
// document's current revision content from storage and writes the size-capped canonical text.
// Safe to re-run: it only touches documents whose searchText is still null.

const SEARCH_TEXT_MAX = 200_000;

let scanned = 0;
let filled = 0;
let missing = 0;

const BATCH = 200;
let cursor: string | undefined;

for (;;) {
  const docs = await prisma.document.findMany({
    where: { deletedAt: null, searchText: null, currentVersionId: { not: null } },
    select: { id: true, currentVersionId: true },
    orderBy: { id: "asc" },
    take: BATCH,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
  if (docs.length === 0) break;
  cursor = docs[docs.length - 1].id;

  for (const doc of docs) {
    scanned += 1;
    const revision = await prisma.documentRevision.findUnique({
      where: { id: doc.currentVersionId! },
      select: { storageKey: true },
    });
    if (!revision) {
      missing += 1;
      continue;
    }
    try {
      const content = await readContent(revision.storageKey);
      const canonical = canonicalize(content);
      const searchText =
        canonical.length > SEARCH_TEXT_MAX ? canonical.slice(0, SEARCH_TEXT_MAX) : canonical;
      // Guarded update: only write if searchText is still null AND the current revision hasn't
      // changed, so a concurrent live write (create/update/push) is never clobbered by the backfill.
      const { count } = await prisma.document.updateMany({
        where: { id: doc.id, searchText: null, currentVersionId: doc.currentVersionId },
        data: { searchText },
      });
      if (count > 0) filled += 1;
    } catch {
      missing += 1;
    }
  }
}

console.log(`Backfilled searchText: scanned ${scanned}, filled ${filled}, missing-content ${missing}.`);
await prisma.$disconnect();
