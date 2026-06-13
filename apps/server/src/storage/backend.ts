import type { Readable } from "node:stream";

// Pluggable object storage. Content is content-addressed (the key is derived from the
// sha256 of canonical content), so writes are idempotent and dedupe across the store.
// Two backends implement this interface: a local filesystem store (default; used by dev,
// tests, and CI) and an S3-compatible store (DigitalOcean Spaces) for hosted deploys.
export interface StoredObject {
  key: string;
  mtimeMs: number; // last-modified (used by the orphan sweep grace window)
}

export interface StorageBackend {
  /** Idempotently store UTF-8 text at `key`. Implementations must refresh last-modified. */
  putText(key: string, text: string): Promise<void>;
  /** Idempotently store raw bytes at `key`. */
  putBytes(key: string, data: Buffer): Promise<void>;
  getText(key: string): Promise<string>;
  getBytes(key: string): Promise<Buffer>;
  /** Current last-modified (ms) for a key, or null if it no longer exists. */
  statMtime(key: string): Promise<number | null>;
  /** List stored objects under a posix key prefix (e.g. "objects/" or "attachments/"). */
  list(prefix: string): Promise<StoredObject[]>;
  /** Delete a key; a no-op if it is already gone. */
  remove(key: string): Promise<void>;
  /**
   * Store a stream at `key` without buffering it in memory (used by import zip uploads).
   * `length` is the exact byte count (from Content-Length) — required by S3 PutObject.
   */
  putStream(key: string, data: Readable, length: number): Promise<void>;
  /** Read a key as a stream (throws StorageNotFoundError when missing). */
  getStream(key: string): Promise<Readable>;
}

/** Thrown by getText/getBytes when the key does not exist. */
export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}
