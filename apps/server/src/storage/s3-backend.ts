import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsCommand,
  PutObjectCommand,
  type ListObjectsCommandOutput,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { StorageNotFoundError, type StorageBackend, type StoredObject } from "./backend.js";

// Minimal shape we need from an S3 client — lets tests inject a fake `send`.
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

// S3-compatible object store (DigitalOcean Spaces). Content is content-addressed, so a
// plain PutObject is idempotent: re-storing identical bytes overwrites with the same
// content and refreshes LastModified. Listing uses the v1 ListObjects + Marker pagination
// (Spaces does not reliably paginate ListObjectsV2), and fails closed on a truncated page
// with no marker so the orphan sweep never silently sees a partial object set.
export class S3Backend implements StorageBackend {
  constructor(
    private readonly client: S3Like,
    private readonly bucket: string,
  ) {}

  async putText(key: string, text: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: text, ContentType: "text/markdown; charset=utf-8" }),
    );
  }

  async putBytes(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async getText(key: string): Promise<string> {
    const out = (await this.get(key)) as { Body?: { transformToString(enc?: string): Promise<string> } };
    if (!out.Body) throw new StorageNotFoundError(key);
    return out.Body.transformToString("utf-8");
  }

  async getBytes(key: string): Promise<Buffer> {
    const out = (await this.get(key)) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!out.Body) throw new StorageNotFoundError(key);
    return Buffer.from(await out.Body.transformToByteArray());
  }

  private async get(key: string): Promise<unknown> {
    try {
      return await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async statMtime(key: string): Promise<number | null> {
    try {
      const out = (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))) as {
        LastModified?: Date;
      };
      return out.LastModified ? out.LastModified.getTime() : 0;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let marker: string | undefined;
    for (;;) {
      const page = (await this.client.send(
        new ListObjectsCommand({ Bucket: this.bucket, Prefix: prefix, Marker: marker }),
      )) as ListObjectsCommandOutput;
      const contents = page.Contents ?? [];
      for (const obj of contents) {
        if (obj.Key) out.push({ key: obj.Key, mtimeMs: obj.LastModified ? obj.LastModified.getTime() : 0 });
      }
      if (!page.IsTruncated) break;
      // No Delimiter is set, so NextMarker may be absent; fall back to the last key.
      const next = page.NextMarker ?? contents[contents.length - 1]?.Key;
      if (!next) throw new Error("S3 list reported truncation with no continuation marker — aborting to avoid a partial sweep");
      marker = next;
    }
    return out;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async putStream(key: string, data: Readable, length: number): Promise<void> {
    // PutObject accepts a stream body when ContentLength is known (the import upload path
    // always knows it from the HTTP Content-Length header), so nothing is buffered here.
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentLength: length }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const out = (await this.get(key)) as { Body?: unknown };
    if (!out.Body) throw new StorageNotFoundError(key);
    return out.Body as Readable;
  }
}
