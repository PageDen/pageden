import { describe, expect, it } from "vitest";
import { PagedenApiClient, PagedenApiError, type RequestTransport } from "./api-client";

class FakeTransport implements RequestTransport {
  calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string | ArrayBuffer }> = [];

  constructor(private readonly response: { status: number; text: string; arrayBuffer?: ArrayBuffer }) {}

  async request(options: { url: string; method: string; headers?: Record<string, string>; body?: string | ArrayBuffer }) {
    this.calls.push(options);
    return this.response;
  }
}

describe("Pageden API client", () => {
  it("sends bearer auth and trims duplicate server URL slashes", async () => {
    const transport = new FakeTransport({ status: 200, text: JSON.stringify({ folders: [], documents: [] }) });
    const api = new PagedenApiClient("https://team.example.com///", "pm_live_test", transport);
    await api.tree("ws 1");

    expect(transport.calls[0]?.url).toBe("https://team.example.com/api/documents/tree?workspaceId=ws%201");
    expect(transport.calls[0]?.headers?.authorization).toBe("Bearer pm_live_test");
  });

  it("surfaces conflict errors with currentVersion", async () => {
    const transport = new FakeTransport({
      status: 409,
      text: JSON.stringify({ error: "conflict", currentVersion: "rev2", message: "stale" }),
    });
    const api = new PagedenApiClient("https://team.example.com", "pm_live_test", transport);

    await expect(api.push("doc1", { baseVersion: "rev1", checksum: "sha256:x", content: "x" })).rejects.toMatchObject({
      status: 409,
      currentVersion: "rev2",
    } satisfies Partial<PagedenApiError>);
  });

  it("searches remote documents with bearer auth", async () => {
    const transport = new FakeTransport({ status: 200, text: JSON.stringify({ results: [] }) });
    const api = new PagedenApiClient("https://team.example.com", "pm_live_test", transport);
    await api.search("ws1", "runbook notes", 10);

    expect(transport.calls[0]?.url).toBe("https://team.example.com/api/search?workspaceId=ws1&q=runbook+notes&limit=10");
    expect(transport.calls[0]?.headers?.authorization).toBe("Bearer pm_live_test");
  });

  it("creates folders and documents through the normal API", async () => {
    const folderTransport = new FakeTransport({ status: 201, text: JSON.stringify({ id: "folder1", path: "imported" }) });
    const api = new PagedenApiClient("https://team.example.com", "pm_live_test", folderTransport);
    await api.createFolder({ workspaceId: "ws1", parentFolderId: null, name: "Imported", slug: "imported" });

    expect(folderTransport.calls[0]?.url).toBe("https://team.example.com/api/folders");
    expect(folderTransport.calls[0]?.headers?.authorization).toBe("Bearer pm_live_test");
    expect(JSON.parse(String(folderTransport.calls[0]?.body ?? "{}"))).toEqual({
      workspaceId: "ws1",
      parentFolderId: null,
      name: "Imported",
      slug: "imported",
    });

    const documentTransport = new FakeTransport({ status: 201, text: JSON.stringify({ id: "doc1", version: "rev1", checksum: "sha256:x", path: "imported/note.md" }) });
    const docApi = new PagedenApiClient("https://team.example.com", "pm_live_test", documentTransport);
    await docApi.createDocument({ workspaceId: "ws1", folderId: "folder1", title: "Note", slug: "note", content: "# Note\n" });

    expect(documentTransport.calls[0]?.url).toBe("https://team.example.com/api/documents");
    expect(JSON.parse(String(documentTransport.calls[0]?.body ?? "{}"))).toEqual({
      workspaceId: "ws1",
      folderId: "folder1",
      title: "Note",
      slug: "note",
      content: "# Note\n",
    });
  });

  it("starts and polls device login without bearer auth", async () => {
    const transport = new FakeTransport({
      status: 201,
      text: JSON.stringify({ deviceCode: "dev", userCode: "ABCD-2345", verificationUri: "https://app/devices", expiresIn: 600, interval: 5 }),
    });
    const api = new PagedenApiClient("https://team.example.com", "", transport);
    await api.deviceStart();

    expect(transport.calls[0]?.url).toBe("https://team.example.com/api/auth/device/start");
    expect(transport.calls[0]?.headers?.authorization).toBeUndefined();

    const pollTransport = new FakeTransport({ status: 200, text: JSON.stringify({ status: "approved", token: "pm_live_new" }) });
    const pollApi = new PagedenApiClient("https://team.example.com", "", pollTransport);
    await expect(pollApi.devicePoll("dev")).resolves.toEqual({ status: "approved", token: "pm_live_new" });
    expect(pollTransport.calls[0]?.url).toBe("https://team.example.com/api/auth/device/poll");
    expect(pollTransport.calls[0]?.headers?.authorization).toBeUndefined();
    expect(JSON.parse(String(pollTransport.calls[0]?.body ?? "{}"))).toEqual({ deviceCode: "dev" });
  });

  it("uploads and downloads attachment bytes", async () => {
    const body = new Uint8Array([1, 2, 3]).buffer;
    const transport = new FakeTransport({
      status: 201,
      text: JSON.stringify({ id: "att1", filename: "a b.png", contentType: "image/png", size: 3, sha256: "abc", createdAt: "now" }),
    });
    const api = new PagedenApiClient("https://team.example.com", "pm_live_test", transport);
    await api.uploadAttachment("doc1", "a b.png", body, "image/png");

    expect(transport.calls[0]?.url).toBe("https://team.example.com/api/documents/doc1/attachments?filename=a%20b.png");
    expect(transport.calls[0]?.headers?.["content-type"]).toBe("image/png");
    expect(transport.calls[0]?.body).toBe(body);

    const downloadBody = new Uint8Array([9]).buffer;
    const downloadTransport = new FakeTransport({ status: 200, text: "", arrayBuffer: downloadBody });
    const downloadApi = new PagedenApiClient("https://team.example.com", "pm_live_test", downloadTransport);
    await expect(downloadApi.downloadAttachment("att1")).resolves.toBe(downloadBody);
  });
});
