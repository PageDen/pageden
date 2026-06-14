import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerMetaStore } from "./metadata";

class MemoryAdapter {
  files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("missing");
    return value;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

describe("server metadata store", () => {
  it("stores .server-meta.json keyed by documentId in the plugin dir", async () => {
    const adapter = new MemoryAdapter();
    const store = new ServerMetaStore(adapter, ".obsidian/plugins/pageden");

    await store.upsert({
      documentId: "doc1",
      localPath: "Remote Docs/runbook.md",
      remotePath: "/engineering/runbook",
      title: "Runbook",
      baseVersion: "rev1",
      checksum: "sha256:one",
      permission: "editor",
      updatedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(store.filePath).toBe(".obsidian/plugins/pageden/.server-meta.json");
    expect(await store.getByLocalPath("Remote Docs/runbook.md")).toMatchObject({ documentId: "doc1" });
    expect(JSON.parse(adapter.files.get(store.filePath) ?? "{}").documents.doc1.baseVersion).toBe("rev1");
  });
});

describe("Obsidian community metadata", () => {
  it("keeps the root manifest in sync with the plugin manifest", () => {
    const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
    const pluginManifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
    const rootManifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
    const pluginVersions = JSON.parse(readFileSync(resolve(root, "versions.json"), "utf8"));
    const rootVersions = JSON.parse(readFileSync(resolve(root, "versions.json"), "utf8"));

    expect(rootManifest).toEqual(pluginManifest);
    expect(rootVersions).toEqual(pluginVersions);
    expect(rootVersions[rootManifest.version]).toBe(rootManifest.minAppVersion);
  });
});
