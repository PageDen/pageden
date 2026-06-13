import type { z } from "zod";
import {
  currentWorkspaceSchema,
  workspaceAvailabilitySchema,
  workspaceCreateSchema,
  attachmentSchema,
  attachmentListSchema,
  documentCreateSchema,
  documentMoveSchema,
  documentRenameSchema,
  documentWithContentSchema,
  groupCreateSchema,
  groupsListSchema,
  permissionsListSchema,
  permissionsWriteSchema,
  searchSchema,
  tokenCreateSchema,
  tokenListSchema,
  deviceLookupSchema,
  userCreateSchema,
  usersListSchema,
  folderCreateSchema,
  folderMoveSchema,
  folderRenameSchema,
  meResponseSchema,
  okDeletedSchema,
  okSchema,
  authConfigSchema,
  importJobSchema,
  importJobStartSchema,
  publicCurrentWorkspaceSchema,
  revisionsSchema,
  treeSchema,
  writeResultSchema,
} from "@pageden/api-types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

// Global 401 handler (wired by the router) so an expired session anywhere bounces to /login.
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: () => void): void {
  onUnauthorized = fn;
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON body (e.g. an upstream proxy error)
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API error ${status}`);
    this.name = "ApiError";
  }
  /** Discriminated error code from the contract, when present. */
  get code(): string | undefined {
    if (this.body && typeof this.body === "object" && "error" in this.body) {
      return String((this.body as { error: unknown }).error);
    }
    return undefined;
  }
}

interface RequestOptions<T> {
  body?: unknown;
  schema?: z.ZodType<T>;
}

async function request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = safeJson(await res.text());
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json);
  if (opts.schema) {
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      // Contract drift: fail loudly in dev/test; in prod surface a controlled error rather
      // than feeding malformed data into the UI.
      if (import.meta.env.DEV) {
        throw new Error(`Contract drift on ${method} ${path}: ${JSON.stringify(parsed.error.issues)}`);
      }
      throw new ApiError(res.status, json);
    }
    return parsed.data;
  }
  return json as T;
}

export const api = {
  me: () => request("GET", "/me", { schema: meResponseSchema }),
  currentWorkspace: () => request("GET", "/workspaces/current", { schema: currentWorkspaceSchema }),
  publicCurrentWorkspace: () => request("GET", "/workspaces/current-public", { schema: publicCurrentWorkspaceSchema }),
  workspaceAvailability: (subdomain: string) =>
    request("GET", `/workspaces/availability?subdomain=${encodeURIComponent(subdomain)}`, { schema: workspaceAvailabilitySchema }),
  createWorkspace: (name: string, subdomain: string) =>
    request("POST", "/workspaces", { body: { name, subdomain }, schema: workspaceCreateSchema }),
  setWorkspaceCustomDomain: (workspaceId: string, customDomain: string | null) =>
    request("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/custom-domain`, { body: { customDomain }, schema: workspaceCreateSchema }),
  register: (email: string, name: string, password: string, companyName: string, subdomain: string, captchaToken?: string) =>
    request("POST", "/auth/register", { body: { email, name, password, companyName, subdomain, captchaToken }, schema: meResponseSchema }),
  verifyEmail: (token: string) => request("POST", "/auth/verify-email", { body: { token }, schema: okSchema }),
  resendVerification: () => request("POST", "/auth/resend-verification", { schema: okSchema }),
  login: (email: string, password: string) =>
    request("POST", "/auth/login", { body: { email, password }, schema: meResponseSchema }),
  logout: () => request("POST", "/auth/logout"),
  authConfig: () => request("GET", "/auth/config", { schema: authConfigSchema }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request("POST", "/auth/change-password", { body: { currentPassword, newPassword }, schema: okSchema }),
  forgotPassword: (email: string, captchaToken?: string) =>
    request("POST", "/auth/forgot-password", { body: { email, captchaToken }, schema: okSchema }),
  resetPassword: (token: string, password: string) =>
    request("POST", "/auth/reset-password", { body: { token, password }, schema: okSchema }),
  tree: (workspaceId: string) =>
    request("GET", `/documents/tree?workspaceId=${encodeURIComponent(workspaceId)}`, { schema: treeSchema }),
  liveBaseUrl: () => `${websocketBaseUrl()}/live`,
  search: (workspaceId: string, q: string, limit = 20) =>
    request("GET", `/search?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(q)}&limit=${limit}`, {
      schema: searchSchema,
    }),
  document: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}`, { schema: documentWithContentSchema }),
  attachments: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/attachments`, { schema: attachmentListSchema }),
  attachmentUrl: (id: string) => `${BASE}/attachments/${encodeURIComponent(id)}`,
  // Absolute URL for embedding in stored Markdown (works in the web app and in Obsidian when
  // online). If BASE is already absolute (dev override) use it as-is, else prefix the origin.
  absoluteAttachmentUrl: (id: string) => {
    const path = `${BASE}/attachments/${encodeURIComponent(id)}`;
    return /^https?:\/\//i.test(path) ? path : `${window.location.origin}${path}`;
  },
  // Upload raw file bytes to a document; returns the parsed attachment. Used by the editor.
  uploadAttachment: async (documentId: string, file: File) => {
    const res = await fetch(
      `${BASE}/documents/${encodeURIComponent(documentId)}/attachments?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      },
    );
    const json = safeJson(await res.text());
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) throw new ApiError(res.status, json);
    const parsed = attachmentSchema.safeParse(json);
    if (!parsed.success) throw new ApiError(res.status, json);
    return parsed.data;
  },
  // Server-side vault import: upload one zip, then poll the job.
  uploadVaultZip: (
    workspaceId: string,
    file: File,
    options: { targetRootName?: string; targetFolderId?: string; conflictPolicy: "skip" | "rename" },
    onProgress?: (percent: number) => void,
  ): Promise<{ jobId: string }> => {
    const query = new URLSearchParams({ workspaceId, conflictPolicy: options.conflictPolicy });
    if (options.targetFolderId) query.set("targetFolderId", options.targetFolderId);
    else query.set("targetRootName", options.targetRootName ?? "Imported");
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.withCredentials = true;
      xhr.open("POST", `${BASE}/import/vault?${query.toString()}`);
      xhr.setRequestHeader("content-type", "application/zip");
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        const json = safeJson(xhr.responseText);
        if (xhr.status === 401 && onUnauthorized) onUnauthorized();
        if (xhr.status < 200 || xhr.status >= 300) return reject(new ApiError(xhr.status, json));
        const parsed = importJobStartSchema.safeParse(json);
        if (!parsed.success) return reject(new ApiError(xhr.status, json));
        resolve(parsed.data);
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, null)));
      xhr.send(file);
    });
  },
  importJob: (id: string) => request("GET", `/import/jobs/${encodeURIComponent(id)}`, { schema: importJobSchema }),
  retryImportJob: (id: string) =>
    request("POST", `/import/jobs/${encodeURIComponent(id)}/retry`, { schema: importJobStartSchema }),
  // Upload with XHR so we can report byte-level progress (fetch has no progress events).
  uploadAttachmentWithProgress: (
    documentId: string,
    file: File,
    onProgress: (percent: number) => void,
  ): Promise<{ id: string; filename: string; contentType: string; size: number; sha256: string; createdAt: string }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.withCredentials = true;
      xhr.open(
        "POST",
        `${BASE}/documents/${encodeURIComponent(documentId)}/attachments?filename=${encodeURIComponent(file.name)}`,
      );
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener("load", () => {
        const json = safeJson(xhr.responseText);
        if (xhr.status === 401 && onUnauthorized) onUnauthorized();
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ApiError(xhr.status, json));
          return;
        }
        const parsed = attachmentSchema.safeParse(json);
        if (!parsed.success) { reject(new ApiError(xhr.status, json)); return; }
        resolve(parsed.data);
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, "Network error")));
      xhr.addEventListener("abort", () => reject(new ApiError(0, "Upload aborted")));
      xhr.send(file);
    });
  },
  revisions: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/revisions`, { schema: revisionsSchema }),
  updateDocument: (id: string, body: { baseVersion: string; content: string; title?: string }) =>
    request("PUT", `/documents/${encodeURIComponent(id)}`, { body, schema: writeResultSchema }),
  restoreRevision: (id: string, revisionId: string) =>
    request("POST", `/documents/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/restore`, {
      schema: writeResultSchema,
    }),
  createDocument: (body: { workspaceId: string; folderId: string; title: string; slug: string; content?: string }) =>
    request("POST", "/documents", { body: { content: "", ...body }, schema: documentCreateSchema }),
  renameDocument: (id: string, body: { slug: string; title?: string }) =>
    request("POST", `/documents/${encodeURIComponent(id)}/rename`, { body, schema: documentRenameSchema }),
  moveDocument: (id: string, folderId: string) =>
    request("POST", `/documents/${encodeURIComponent(id)}/move`, { body: { folderId }, schema: documentMoveSchema }),
  deleteDocument: (id: string) =>
    request("DELETE", `/documents/${encodeURIComponent(id)}`, { schema: okDeletedSchema }),
  createFolder: (body: { workspaceId: string; parentFolderId: string | null; name: string; slug: string }) =>
    request("POST", "/folders", { body, schema: folderCreateSchema }),
  renameFolder: (id: string, body: { name: string; slug: string }) =>
    request("POST", `/folders/${encodeURIComponent(id)}/rename`, { body, schema: folderRenameSchema }),
  moveFolder: (id: string, parentFolderId: string | null) =>
    request("POST", `/folders/${encodeURIComponent(id)}/move`, { body: { parentFolderId }, schema: folderMoveSchema }),
  deleteFolder: (id: string) =>
    request("DELETE", `/folders/${encodeURIComponent(id)}`, { schema: okSchema }),

  // --- admin / management ---
  users: (workspaceId: string) =>
    request("GET", `/users?workspaceId=${encodeURIComponent(workspaceId)}`, { schema: usersListSchema }),
  createUser: (body: { workspaceId: string; email: string; name: string; password: string; role: "member" | "admin" }) =>
    request("POST", "/users", { body, schema: userCreateSchema }),
  groups: (workspaceId: string) =>
    request("GET", `/groups?workspaceId=${encodeURIComponent(workspaceId)}`, { schema: groupsListSchema }),
  createGroup: (body: { workspaceId: string; name: string; slug: string }) =>
    request("POST", "/groups", { body, schema: groupCreateSchema }),
  addGroupMember: (groupId: string, userId: string) =>
    request("POST", `/groups/${encodeURIComponent(groupId)}/members`, { body: { userId }, schema: okSchema }),
  removeGroupMember: (groupId: string, userId: string) =>
    request("DELETE", `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { schema: okSchema }),
  tokens: () => request("GET", "/tokens", { schema: tokenListSchema }),
  lookupDevice: (userCode: string) =>
    request("GET", `/auth/device/lookup?userCode=${encodeURIComponent(userCode)}`, { schema: deviceLookupSchema }),
  approveDevice: (userCode: string, action: "approve" | "deny") =>
    request("POST", "/auth/device/approve", { body: { userCode, action }, schema: okSchema }),
  createToken: (
    name: string,
    options: { kind?: "personal" | "obsidian" | "agent"; scopes?: string[]; workspaceId?: string | null; expiresAt?: string | null } = {},
  ) => request("POST", "/tokens", { body: { name, ...options }, schema: tokenCreateSchema }),
  revokeToken: (id: string) => request("POST", `/tokens/${encodeURIComponent(id)}/revoke`, { schema: okSchema }),
  testMcpToken: async (token: string, workspaceId?: string) => {
    const url = new URL("/mcp", window.location.origin);
    if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const json = safeJson(await res.text());
    if (!res.ok) throw new ApiError(res.status, json);
    return json as { result?: { tools?: Array<{ name: string }> }; error?: { message?: string } };
  },
  documentPermissions: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/permissions`, { schema: permissionsListSchema }),
  setDocumentPermissions: (id: string, permissions: PermissionInput[], version?: string) =>
    request("PUT", `/documents/${encodeURIComponent(id)}/permissions`, { body: { permissions, version }, schema: permissionsWriteSchema }),
  folderPermissions: (id: string) =>
    request("GET", `/folders/${encodeURIComponent(id)}/permissions`, { schema: permissionsListSchema }),
  setFolderPermissions: (id: string, permissions: PermissionInput[], version?: string) =>
    request("PUT", `/folders/${encodeURIComponent(id)}/permissions`, { body: { permissions, version }, schema: permissionsWriteSchema }),
};

function websocketBaseUrl(): string {
  if (/^https?:\/\//i.test(BASE)) {
    const url = new URL(BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/+$/, "");
  }
  const base = BASE.startsWith("/") ? BASE : `/${BASE}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${base}`.replace(/\/+$/, "");
}

export interface PermissionInput {
  subjectType: "user" | "group";
  subjectId: string;
  role: "viewer" | "editor" | "manager";
}

/** Human-readable message for a CRUD failure, covering the backend's expected outcomes. */
export function crudErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400 && error.body && typeof error.body === "object") {
      const body = error.body as { fields?: Record<string, string>; message?: string };
      if (body.fields) return Object.values(body.fields)[0] ?? "Invalid request.";
      if (body.message) return body.message;
      return "Invalid request.";
    }
    if (error.status === 403) return "You no longer have permission to do that.";
    if (error.status === 404) return "That item is no longer available.";
    if (error.status === 409) {
      const m = (error.body as { message?: string } | null)?.message;
      return m ?? "This changed on the server — reload and try again.";
    }
    if (error.status === 429) return "Too many requests — wait a moment and try again.";
  }
  return "Something went wrong.";
}

/** Narrow an unknown error to the conflict body shape (409). */
export function conflictVersion(error: unknown): string | null {
  if (error instanceof ApiError && error.status === 409 && error.body && typeof error.body === "object") {
    const v = (error.body as { currentVersion?: unknown }).currentVersion;
    return typeof v === "string" ? v : null;
  }
  return null;
}
