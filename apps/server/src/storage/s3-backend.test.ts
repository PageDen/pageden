import { describe, it, expect } from "vitest";
import { S3Backend, type S3Like } from "./s3-backend.js";
import { StorageNotFoundError } from "./backend.js";

// In-memory fake S3: inspects command constructor name + input. Supports v1 ListObjects
// Marker pagination (one key per page) and HeadObject.
function fakeS3(seed: Record<string, Buffer> = {}) {
  const store = new Map<string, Buffer>(Object.entries(seed));
  const client: S3Like = {
    async send(command: unknown): Promise<unknown> {
      const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
      const name = cmd.constructor.name;
      const i = cmd.input as { Key?: string; Body?: unknown; Prefix?: string; Marker?: string };
      if (name === "PutObjectCommand") {
        store.set(i.Key!, typeof i.Body === "string" ? Buffer.from(i.Body, "utf8") : Buffer.from(i.Body as Buffer));
        return {};
      }
      if (name === "GetObjectCommand") {
        const buf = store.get(i.Key!);
        if (!buf) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return {
          Body: {
            transformToString: async () => buf.toString("utf8"),
            transformToByteArray: async () => new Uint8Array(buf),
          },
        };
      }
      if (name === "HeadObjectCommand") {
        if (!store.has(i.Key!)) throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
        return { LastModified: new Date(5000) };
      }
      if (name === "ListObjectsCommand") {
        const keys = [...store.keys()].filter((k) => k.startsWith(i.Prefix ?? "")).sort();
        const start = i.Marker ? keys.indexOf(i.Marker) + 1 : 0;
        const key = keys[start];
        if (key === undefined) return { Contents: [], IsTruncated: false };
        const more = start + 1 < keys.length;
        return { Contents: [{ Key: key, LastModified: new Date(1000 + start) }], IsTruncated: more };
      }
      if (name === "DeleteObjectCommand") {
        store.delete(i.Key!);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  return { client, store };
}

describe("S3Backend (Spaces)", () => {
  it("round-trips text and bytes", async () => {
    const b = new S3Backend(fakeS3().client, "bucket");
    await b.putText("objects/ab/x.md", "# Hi\n");
    expect(await b.getText("objects/ab/x.md")).toBe("# Hi\n");
    const data = Buffer.from([1, 2, 3, 4]);
    await b.putBytes("attachments/ab/x", data);
    expect(Buffer.compare(await b.getBytes("attachments/ab/x"), data)).toBe(0);
  });

  it("lists across paginated pages (v1 marker) with mtimes", async () => {
    const b = new S3Backend(fakeS3().client, "bucket");
    await b.putText("objects/aa/1.md", "a");
    await b.putText("objects/bb/2.md", "b");
    await b.putBytes("attachments/cc/3", Buffer.from("c"));
    const objs = await b.list("objects/");
    expect(objs.map((o) => o.key).sort()).toEqual(["objects/aa/1.md", "objects/bb/2.md"]);
    expect(objs.every((o) => o.mtimeMs > 0)).toBe(true);
    expect((await b.list("attachments/")).length).toBe(1);
  });

  it("statMtime returns a time for present keys and null for missing", async () => {
    const { client } = fakeS3({ "objects/aa/1.md": Buffer.from("x") });
    const b = new S3Backend(client, "bucket");
    expect(await b.statMtime("objects/aa/1.md")).toBe(5000);
    expect(await b.statMtime("objects/zz/missing.md")).toBeNull();
  });

  it("maps a missing object to StorageNotFoundError", async () => {
    const b = new S3Backend(fakeS3().client, "bucket");
    await expect(b.getText("objects/aa/none.md")).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(b.getBytes("attachments/aa/none")).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("removes keys", async () => {
    const { client, store } = fakeS3({ "objects/aa/1.md": Buffer.from("x") });
    const b = new S3Backend(client, "bucket");
    await b.remove("objects/aa/1.md");
    expect(store.has("objects/aa/1.md")).toBe(false);
  });
});
