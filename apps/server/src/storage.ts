import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { S3Client } from "@aws-sdk/client-s3";
import { canonicalize } from "./checksum.js";
import { prisma as defaultPrisma } from "./prisma.js";
import { env } from "./env.js";
import type { StorageBackend } from "./storage/backend.js";
import { FsBackend } from "./storage/fs-backend.js";
import { S3Backend } from "./storage/s3-backend.js";

// Content is stored content-addressed and immutable: the storage key is derived from the
// sha256 of the canonical content. Identical content reuses the same object, so writes are
// idempotent and a retry after a crash cannot create a divergent object (review H4).
// Keys are logical posix paths (forward slashes) — persisted in the DB and compared
// equal regardless of host OS, and used directly as object keys in S3/Spaces.
export function storageKeyForHex(hex: string): string {
  return ["objects", hex.slice(0, 2), `${hex}.md`].join("/");
}

export function attachmentKeyForHex(hex: string): string {
  return ["attachments", hex.slice(0, 2), hex].join("/");
}

// Backend is chosen once by STORAGE_DRIVER. `fs` (default) is used by dev/test/CI; `spaces`
// (S3-compatible) is used by hosted deploys. Lazily constructed so importing this module in
// unit tests never requires S3 credentials.
let backendInstance: StorageBackend | undefined;

/** Construct the configured backend (no caching). Exported for tests. */
export function createBackend(): StorageBackend {
  return env.storageDriver === "spaces" ? createSpacesBackend() : new FsBackend(env.storageRoot);
}

function backend(): StorageBackend {
  return (backendInstance ??= createBackend());
}

export function createSpacesBackend(): StorageBackend {
  if (!env.spacesBucket || !env.spacesAccessKeyId || !env.spacesSecretAccessKey) {
    throw new Error("STORAGE_DRIVER=spaces requires SPACES_BUCKET, SPACES_ACCESS_KEY_ID, and SPACES_SECRET_ACCESS_KEY.");
  }
  const client = new S3Client({
    region: env.spacesRegion,
    endpoint: env.spacesEndpoint,
    forcePathStyle: env.spacesForcePathStyle,
    credentials: { accessKeyId: env.spacesAccessKeyId, secretAccessKey: env.spacesSecretAccessKey },
  });
  return new S3Backend(client, env.spacesBucket);
}

/** For tests: inject a backend and reset the cached singleton. */
export function setStorageBackend(b: StorageBackend | undefined): void {
  backendInstance = b;
}

/** Write canonical content; returns the immutable storage key and its sha256 hex. */
export async function writeContent(content: string): Promise<{ storageKey: string; hex: string }> {
  const canonical = canonicalize(content);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex");
  const storageKey = storageKeyForHex(hex);
  await backend().putText(storageKey, canonical);
  return { storageKey, hex };
}

export async function readContent(storageKey: string): Promise<string> {
  assertReadableKey(storageKey);
  return backend().getText(storageKey);
}

/** Write raw bytes content-addressed; returns the immutable key, sha256 hex, and byte length. */
export async function writeBlob(data: Buffer): Promise<{ storageKey: string; hex: string; size: number }> {
  const hex = createHash("sha256").update(data).digest("hex");
  const storageKey = attachmentKeyForHex(hex);
  await backend().putBytes(storageKey, data);
  return { storageKey, hex, size: data.length };
}

export async function readBlob(storageKey: string): Promise<Buffer> {
  assertReadableKey(storageKey);
  return backend().getBytes(storageKey);
}

// ---------------------------------------------------------------------------
// Orphan sweep (Milestone 5). Content is written content-addressed BEFORE the
// document write transaction, so a rolled-back write can leave an object that no
// DocumentRevision references. This sweep deletes unreferenced objects older than a
// grace period (so it never races an in-flight, not-yet-committed write). Backend-agnostic.
// ---------------------------------------------------------------------------
const OBJECT_KEY_RE = /^objects\/[0-9a-f]{2}\/[0-9a-f]{64}\.md$/;
const ATTACHMENT_KEY_RE = /^attachments\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

// Reads only accept well-formed content-addressed keys. Keys come from our own DB rows,
// but validating here is cheap defense-in-depth against ever reading an arbitrary object.
function assertReadableKey(key: string): void {
  if (!OBJECT_KEY_RE.test(key) && !ATTACHMENT_KEY_RE.test(key)) {
    throw new Error(`Refusing to read malformed storage key: ${key}`);
  }
}

// NOTE: pass a Prisma client bound to the PRIMARY database. A read replica that lags behind
// a just-committed revision could let the sweep treat a live object as an orphan and delete it.
export async function sweepOrphanObjects(
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
  minAgeMs = 60 * 60 * 1000,
): Promise<{ removed: number; kept: number }> {
  const b = backend();
  const listed = [...(await b.list("objects/")), ...(await b.list("attachments/"))].filter(
    (o) => OBJECT_KEY_RE.test(o.key) || ATTACHMENT_KEY_RE.test(o.key),
  );
  const revisions = await client.documentRevision.findMany({ select: { storageKey: true } });
  const attachments = await client.attachment.findMany({ where: { deletedAt: null }, select: { storageKey: true } });
  const referenced = new Set([...revisions.map((r) => r.storageKey), ...attachments.map((a) => a.storageKey)]);
  const now = Date.now();
  let removed = 0;
  let kept = 0;
  for (const obj of listed) {
    if (referenced.has(obj.key)) {
      kept += 1;
      continue;
    }
    // Re-read last-modified at delete time (not the earlier list snapshot): a concurrent
    // writer refreshes it before its DB commit, so an in-flight rewrite reads as "too new".
    const mtimeMs = await b.statMtime(obj.key);
    if (mtimeMs === null) continue; // already gone
    if (now - mtimeMs < minAgeMs) {
      kept += 1; // too new — may be an in-flight write
      continue;
    }
    await b.remove(obj.key);
    removed += 1;
  }
  return { removed, kept };
}
