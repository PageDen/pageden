import { requestUrl } from "obsidian";
import type {
  Attachment,
  AttachmentListResponse,
  CreateDocumentResponse,
  CreateFolderResponse,
  DevicePollResponse,
  DeviceStartResponse,
  MeResponse,
  RemoteDocumentWithContent,
  RemoteTree,
  SearchResponse,
  WriteResult,
} from "./types";

export class PagedenApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Pageden API error ${status}`);
    this.name = "PagedenApiError";
  }

  get code(): string | undefined {
    if (this.body && typeof this.body === "object" && "error" in this.body) {
      return String((this.body as { error: unknown }).error);
    }
    return undefined;
  }

  get currentVersion(): string | null {
    if (this.body && typeof this.body === "object" && "currentVersion" in this.body) {
      const value = (this.body as { currentVersion: unknown }).currentVersion;
      return typeof value === "string" ? value : null;
    }
    return null;
  }
}

export interface RequestTransport {
  request(options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
  }): Promise<{ status: number; text: string; arrayBuffer?: ArrayBuffer }>;
}

export class ObsidianRequestTransport implements RequestTransport {
  async request(options: { url: string; method: string; headers?: Record<string, string>; body?: string | ArrayBuffer }) {
    const response = await requestUrl(options);
    return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
  }
}

export class PagedenApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly transport: RequestTransport = new ObsidianRequestTransport(),
  ) {}

  me(): Promise<MeResponse> {
    return this.request("GET", "/me");
  }

  async validate(): Promise<void> {
    await this.me();
  }

  tree(workspaceId: string): Promise<RemoteTree> {
    return this.request("GET", `/documents/tree?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  getDocument(id: string): Promise<RemoteDocumentWithContent> {
    return this.request("GET", `/documents/${encodeURIComponent(id)}`);
  }

  createFolder(body: { workspaceId: string; parentFolderId: string | null; name: string; slug: string }): Promise<CreateFolderResponse> {
    return this.request("POST", "/folders", body);
  }

  createDocument(body: { workspaceId: string; folderId: string; title: string; slug: string; content: string }): Promise<CreateDocumentResponse> {
    return this.request("POST", "/documents", body);
  }

  push(documentId: string, body: { baseVersion: string; checksum: string; content: string }): Promise<WriteResult> {
    return this.request("POST", `/documents/${encodeURIComponent(documentId)}/push`, body);
  }

  search(workspaceId: string, q: string, limit = 20): Promise<SearchResponse> {
    const params = new URLSearchParams({ workspaceId, q, limit: String(limit) });
    return this.request("GET", `/search?${params.toString()}`);
  }

  deviceStart(): Promise<DeviceStartResponse> {
    return this.request("POST", "/auth/device/start", undefined, { auth: false });
  }

  devicePoll(deviceCode: string): Promise<DevicePollResponse> {
    return this.request("POST", "/auth/device/poll", { deviceCode }, { auth: false });
  }

  attachments(documentId: string): Promise<AttachmentListResponse> {
    return this.request("GET", `/documents/${encodeURIComponent(documentId)}/attachments`);
  }

  uploadAttachment(documentId: string, filename: string, data: ArrayBuffer, contentType = "application/octet-stream"): Promise<Attachment> {
    return this.request("POST", `/documents/${encodeURIComponent(documentId)}/attachments?filename=${encodeURIComponent(filename)}`, data, {
      contentType,
      raw: true,
    });
  }

  async downloadAttachment(attachmentId: string): Promise<ArrayBuffer> {
    const response = await this.rawRequest("GET", `/attachments/${encodeURIComponent(attachmentId)}`);
    if (response.arrayBuffer) return response.arrayBuffer;
    return new TextEncoder().encode(response.text).buffer;
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    await this.request("DELETE", `/attachments/${encodeURIComponent(attachmentId)}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { auth?: boolean; contentType?: string; raw?: boolean } = {},
  ): Promise<T> {
    const response = await this.rawRequest(method, path, body, options);
    const json = safeJson(response.text);
    if (response.status < 200 || response.status >= 300) {
      throw new PagedenApiError(response.status, json);
    }
    return json as T;
  }

  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    options: { auth?: boolean; contentType?: string; raw?: boolean } = {},
  ): Promise<{ status: number; text: string; arrayBuffer?: ArrayBuffer }> {
    const headers = {
      ...(options.auth === false || !this.token ? {} : { authorization: `Bearer ${this.token}` }),
      ...(body === undefined ? {} : { "content-type": options.contentType ?? "application/json" }),
    };
    const response = await this.transport.request({
      method,
      url: `${this.serverUrl.replace(/\/+$/, "")}/api${path}`,
      headers,
      body: body === undefined ? undefined : options.raw ? (body as ArrayBuffer) : JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new PagedenApiError(response.status, safeJson(response.text));
    }
    return response;
  }
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
