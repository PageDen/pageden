import type { DataAdapter } from "obsidian";
import type { ServerMetaAttachmentEntry, ServerMetaEntry, ServerMetaFile } from "./types";

export class ServerMetaStore {
  private readonly path: string;

  constructor(
    private readonly adapter: Pick<DataAdapter, "exists" | "read" | "write">,
    pluginDir: string,
  ) {
    this.path = `${pluginDir.replace(/\/+$/, "")}/.server-meta.json`;
  }

  get filePath(): string {
    return this.path;
  }

  async read(): Promise<ServerMetaFile> {
    if (!(await this.adapter.exists(this.path))) return { documents: {}, attachments: {} };
    const raw = await this.adapter.read(this.path);
    const parsed = JSON.parse(raw) as Partial<ServerMetaFile>;
    return { documents: parsed.documents ?? {}, attachments: parsed.attachments ?? {} };
  }

  async write(meta: ServerMetaFile): Promise<void> {
    await this.adapter.write(this.path, JSON.stringify(meta, null, 2));
  }

  async list(): Promise<ServerMetaEntry[]> {
    const meta = await this.read();
    return Object.values(meta.documents);
  }

  async getByLocalPath(localPath: string): Promise<ServerMetaEntry | null> {
    const meta = await this.read();
    return Object.values(meta.documents).find((entry) => entry.localPath === localPath) ?? null;
  }

  async upsert(entry: ServerMetaEntry): Promise<void> {
    const meta = await this.read();
    meta.documents[entry.documentId] = entry;
    await this.write(meta);
  }

  async listAttachments(): Promise<ServerMetaAttachmentEntry[]> {
    const meta = await this.read();
    return Object.values(meta.attachments ?? {});
  }

  async listAttachmentsForDocument(documentId: string): Promise<ServerMetaAttachmentEntry[]> {
    const meta = await this.read();
    return Object.values(meta.attachments ?? {}).filter((entry) => entry.documentId === documentId);
  }

  async upsertAttachment(entry: ServerMetaAttachmentEntry): Promise<void> {
    const meta = await this.read();
    meta.attachments ??= {};
    meta.attachments[entry.attachmentId] = entry;
    await this.write(meta);
  }

  async removeAttachment(attachmentId: string): Promise<void> {
    const meta = await this.read();
    if (!meta.attachments) return;
    delete meta.attachments[attachmentId];
    await this.write(meta);
  }
}
