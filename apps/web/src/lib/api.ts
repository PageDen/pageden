import type { z } from "zod";
import {
  currentWorkspaceSchema,
  accountDeletionCodeSchema,
  accountDeletionPreviewSchema,
  accountDeletionResultSchema,
  workspaceAvailabilitySchema,
  workspaceCreateSchema,
  workspaceLogoSchema,
  auditListSchema,
  auditRetentionSchema,
  auditCheckpointSchema,
  auditIntegritySchema,
  attachmentSchema,
  attachmentListSchema,
  documentCreateSchema,
  decisionAddResponseSchema,
  documentMoveSchema,
  documentRenameSchema,
  documentWorkspaceTransferSchema,
  documentWithContentSchema,
  handoffPacketSchema,
  activityFeedSchema,
  dashboardStatsSchema,
  documentCommentsListSchema,
  documentCommentResponseSchema,
  documentCommentMentionUsersSchema,
  workspaceClaimsListSchema,
  groupCreateSchema,
  groupsListSchema,
  permissionsListSchema,
  permissionDeleteResponseSchema,
  permissionGrantSchema,
  permissionRowResponseSchema,
  permissionsWriteSchema,
  relatedDocsSchema,
  folderDefaultRoleSchema,
  documentShareResponseSchema,
  documentShareListSchema,
  agentEditScopeSchema,
  agentEditScopeUpdateSchema,
  searchSchema,
  tokenCreateSchema,
  tokenListSchema,
  deviceLookupSchema,
  userCreateSchema,
  usersListSchema,
  folderCreateSchema,
  folderEmptySchema,
  folderMoveSchema,
  folderRenameSchema,
  folderWorkspaceTransferSchema,
  meResponseSchema,
  okDeletedSchema,
  okSchema,
  authConfigSchema,
  publicCurrentWorkspaceSchema,
  documentHistorySchema,
  documentDiffSchema,
  revisionDetailSchema,
  revisionsSchema,
  treeSchema,
  writeResultSchema,
  workspaceTransferSettingsSchema,
  workspacePublicSharingSettingsSchema,
  publicShareSchema,
  publicSharePageSchema,
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

// Pull the filename out of a Content-Disposition header, preferring the RFC 5987 `filename*`
// (UTF-8) form over the plain `filename="..."` token. Returns null if neither is present.
function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      // fall through to the plain filename
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain?.[1]?.trim() || null;
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
  skipUnauthorizedRedirect?: boolean;
}

async function request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = safeJson(await res.text());
  if (res.status === 401 && onUnauthorized && !opts.skipUnauthorizedRedirect) onUnauthorized();
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

export type AuditFilters = {
  action?: string[];
  actorUserId?: string;
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
  format?: string;
};

function auditQuery(filters: AuditFilters): string {
  const qs = new URLSearchParams();
  for (const a of filters.action ?? []) qs.append("action", a);
  if (filters.actorUserId) qs.set("actorUserId", filters.actorUserId);
  if (filters.from) qs.set("from", filters.from);
  if (filters.to) qs.set("to", filters.to);
  if (filters.before) qs.set("before", filters.before);
  if (filters.limit) qs.set("limit", String(filters.limit));
  if (filters.format) qs.set("format", filters.format);
  return qs.toString();
}

export const api = {
  me: () => request("GET", "/me", { schema: meResponseSchema }),
  markOnboarded: () => request("POST", "/me/onboarded", { schema: okSchema }),
  currentWorkspace: () => request("GET", "/workspaces/current", { schema: currentWorkspaceSchema }),
  publicCurrentWorkspace: () => request("GET", "/workspaces/current-public", { schema: publicCurrentWorkspaceSchema }),
  workspaceAvailability: (subdomain: string) =>
    request("GET", `/workspaces/availability?subdomain=${encodeURIComponent(subdomain)}`, { schema: workspaceAvailabilitySchema }),
  createWorkspace: (name: string, subdomain: string) =>
    request("POST", "/workspaces", { body: { name, subdomain }, schema: workspaceCreateSchema }),
  uploadWorkspaceLogo: async (workspaceId: string, file: File) => {
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/logo`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const json = safeJson(await res.text());
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) throw new ApiError(res.status, json);
    const parsed = workspaceLogoSchema.safeParse(json);
    if (!parsed.success) throw new ApiError(res.status, json);
    return parsed.data;
  },
  deleteWorkspaceLogo: (workspaceId: string) =>
    request("DELETE", `/workspaces/${encodeURIComponent(workspaceId)}/logo`, { schema: okSchema }),
  auditEvents: (workspaceId: string, filters: AuditFilters = {}) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/audit?${auditQuery(filters)}`, { schema: auditListSchema }),
  accountActivity: (filters: AuditFilters = {}) =>
    request("GET", `/me/account-activity?${auditQuery(filters)}`, { schema: auditListSchema }),
  auditRetention: (workspaceId: string) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/settings/audit-retention`, { schema: auditRetentionSchema }),
  setAuditRetention: (workspaceId: string, auditRetentionDays: number | null) =>
    request("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/settings/audit-retention`, { body: { auditRetentionDays }, schema: auditRetentionSchema }),
  auditIntegrity: (workspaceId: string) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/audit/integrity`, { schema: auditIntegritySchema }),
  createAuditCheckpoint: (workspaceId: string) =>
    request("POST", `/workspaces/${encodeURIComponent(workspaceId)}/audit/checkpoint`, { schema: auditCheckpointSchema }),
  downloadAuditExport: async (workspaceId: string, format: "csv" | "json", filters: AuditFilters = {}) => {
    const qs = auditQuery({ ...filters, format });
    const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}/audit/export?${qs}`, { credentials: "include" });
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) throw new ApiError(res.status, safeJson(await res.text()));
    const blob = await res.blob();
    return { blob, truncated: res.headers.get("x-audit-export-truncated") === "true", filename: `audit-${workspaceId}-${new Date().toISOString().slice(0, 10)}.${format}` };
  },
  setWorkspaceCustomDomain: (workspaceId: string, customDomain: string | null) =>
    request("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/custom-domain`, { body: { customDomain }, schema: workspaceCreateSchema }),
  workspaceTransferSettings: (workspaceId: string) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/settings/workspace-transfer`, { schema: workspaceTransferSettingsSchema }),
  setWorkspaceTransferSettings: (workspaceId: string, enabled: boolean) =>
    request("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/settings/workspace-transfer`, { body: { enabled }, schema: workspaceTransferSettingsSchema }),
  workspacePublicSharingSettings: (workspaceId: string) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/settings/public-sharing`, { schema: workspacePublicSharingSettingsSchema }),
  setWorkspacePublicSharingSettings: (workspaceId: string, enabled: boolean) =>
    request("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/settings/public-sharing`, { body: { enabled }, schema: workspacePublicSharingSettingsSchema }),
  publicShare: (slug: string, password?: string | null) => {
    const qs = password ? `?password=${encodeURIComponent(password)}` : "";
    return request("GET", `/public/shares/${encodeURIComponent(slug)}${qs}`, { schema: publicShareSchema, skipUnauthorizedRedirect: true });
  },
  publicSharePage: (slug: string, docId: string, password?: string | null) => {
    const params = new URLSearchParams({ docId });
    if (password) params.set("password", password);
    return request("GET", `/public/shares/${encodeURIComponent(slug)}/page?${params.toString()}`, {
      schema: publicSharePageSchema,
      skipUnauthorizedRedirect: true,
    });
  },
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
  accountDeletionPreview: () => request("GET", "/account/deletion-preview", { schema: accountDeletionPreviewSchema }),
  sendAccountDeletionCode: () =>
    request("POST", "/account/deletion-code", { schema: accountDeletionCodeSchema }),
  deleteAccount: (confirm: string, code: string) =>
    request("DELETE", "/account", { body: { confirm, code }, schema: accountDeletionResultSchema }),
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
  // Download a document as a Markdown file (server reconstructs frontmatter + Content-Disposition).
  // Returns the raw bytes + the server-provided filename; the caller triggers the browser save.
  downloadDocument: async (id: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`${BASE}/documents/${encodeURIComponent(id)}/download`, { credentials: "include" });
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) throw new ApiError(res.status, safeJson(await res.text()));
    const blob = await res.blob();
    const filename = filenameFromContentDisposition(res.headers.get("content-disposition")) ?? `${id}.md`;
    return { blob, filename };
  },
  documentHandoff: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/handoff`, { schema: handoffPacketSchema }),
  documentRelatedDocs: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/related-docs`, { schema: relatedDocsSchema }),
  workspaceActivity: (workspaceId: string, before?: string) =>
    request(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/activity${before ? `?before=${encodeURIComponent(before)}` : ""}`,
      { schema: activityFeedSchema },
    ),
  workspaceDashboard: (workspaceId: string) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/dashboard`, { schema: dashboardStatsSchema }),
  workspaceClaims: (workspaceId: string) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/claims`, { schema: workspaceClaimsListSchema }),
  documentComments: (documentId: string, includeResolved = false) =>
    request(
      "GET",
      `/documents/${encodeURIComponent(documentId)}/comments${includeResolved ? "?includeResolved=true" : ""}`,
      { schema: documentCommentsListSchema },
    ),
  addDocumentComment: (documentId: string, payload: { body: string; sectionAnchor?: string | null; mentionedUserIds?: string[] }) =>
    request(
      "POST",
      `/documents/${encodeURIComponent(documentId)}/comments`,
      { body: payload, schema: documentCommentResponseSchema },
    ),
  documentCommentMentionUsers: (documentId: string) =>
    request("GET", `/documents/${encodeURIComponent(documentId)}/comment-mention-users`, { schema: documentCommentMentionUsersSchema }),
  resolveComment: (commentId: string) =>
    request("POST", `/comments/${encodeURIComponent(commentId)}/resolve`, { schema: documentCommentResponseSchema }),
  deleteComment: (commentId: string) => request("DELETE", `/comments/${encodeURIComponent(commentId)}`, { schema: okSchema }),
  attachments: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/attachments`, { schema: attachmentListSchema }),
  attachmentMeta: (id: string) =>
    request("GET", `/attachments/${encodeURIComponent(id)}/meta`, { schema: attachmentSchema }),
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
  // Upload with XHR so we can report byte-level progress (fetch has no progress events).
  uploadAttachmentWithProgress: (
    documentId: string,
    file: File,
    onProgress: (percent: number) => void,
  ): Promise<z.infer<typeof attachmentSchema>> => {
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
  uploadVaultZip: (
    file: File,
    options: { workspaceId: string; targetRootName: string; conflictPolicy: "skip" | "rename" },
    onProgress: (percent: number) => void,
  ): Promise<{ jobId: string }> => {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        workspaceId: options.workspaceId,
        targetRootName: options.targetRootName,
        conflictPolicy: options.conflictPolicy,
      });
      const xhr = new XMLHttpRequest();
      xhr.withCredentials = true;
      xhr.open("POST", `${BASE}/import/vault?${params.toString()}`);
      xhr.setRequestHeader("content-type", file.type || "application/zip");
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
        if (!json || typeof json !== "object" || typeof (json as { jobId?: unknown }).jobId !== "string") {
          reject(new ApiError(xhr.status, json));
          return;
        }
        resolve({ jobId: (json as { jobId: string }).jobId });
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, "Network error")));
      xhr.addEventListener("abort", () => reject(new ApiError(0, "Upload aborted")));
      xhr.send(file);
    });
  },
  importJob: (id: string) => request<ImportJob>("GET", `/import/jobs/${encodeURIComponent(id)}`),
  retryImportJob: (id: string) => request<{ jobId: string }>("POST", `/import/jobs/${encodeURIComponent(id)}/retry`),
  revisions: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/revisions`, { schema: revisionsSchema }),
  documentHistory: (id: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/history`, { schema: documentHistorySchema }),
  documentDiff: (id: string, fromVersion: string, toVersion: string) =>
    request(
      "GET",
      `/documents/${encodeURIComponent(id)}/diff?fromVersion=${encodeURIComponent(fromVersion)}&toVersion=${encodeURIComponent(toVersion)}`,
      { schema: documentDiffSchema },
    ),
  revisionDetail: (id: string, revisionId: string) =>
    request("GET", `/documents/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`, {
      schema: revisionDetailSchema,
    }),
  updateDocument: (
    id: string,
    body: {
      baseVersion: string;
      content: string;
      title?: string;
      allowDraft?: boolean;
    },
  ) =>
    request("PUT", `/documents/${encodeURIComponent(id)}`, { body, schema: writeResultSchema }),
  markDocumentCanonical: (id: string) =>
    request("POST", `/documents/${encodeURIComponent(id)}/mark-canonical`, { schema: writeResultSchema }),
  addDecision: (
    id: string,
    body: {
      baseVersion: string;
      id: string;
      status: string;
      owner: string;
      decision: string;
      reason: string;
      replaces?: string | null;
      allowDraft?: boolean;
    },
  ) =>
    request("POST", `/documents/${encodeURIComponent(id)}/decisions`, { body, schema: decisionAddResponseSchema }),
  restoreRevision: (id: string, revisionId: string) =>
    request("POST", `/documents/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/restore`, {
      schema: writeResultSchema,
    }),
  updateRevisionMetadata: (id: string, revisionId: string, body: { label?: string | null; isPinned?: boolean }) =>
    request("PATCH", `/documents/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`, { body, schema: okSchema }),
  createDocument: (body: { workspaceId: string; folderId: string; title: string; slug: string; content?: string }) =>
    request("POST", "/documents", { body: { content: "", ...body }, schema: documentCreateSchema }),
  renameDocument: (id: string, body: { slug: string; title?: string }) =>
    request("POST", `/documents/${encodeURIComponent(id)}/rename`, { body, schema: documentRenameSchema }),
  moveDocument: (id: string, folderId: string) =>
    request("POST", `/documents/${encodeURIComponent(id)}/move`, { body: { folderId }, schema: documentMoveSchema }),
  transferDocumentWorkspace: (id: string, workspaceId: string, folderId: string) =>
    request("POST", `/documents/${encodeURIComponent(id)}/transfer-workspace`, { body: { workspaceId, folderId }, schema: documentWorkspaceTransferSchema }),
  deleteDocument: (id: string) =>
    request("DELETE", `/documents/${encodeURIComponent(id)}`, { schema: okDeletedSchema }),
  createFolder: (body: { workspaceId: string; parentFolderId: string | null; name: string; slug: string }) =>
    request("POST", "/folders", { body, schema: folderCreateSchema }),
  renameFolder: (id: string, body: { name: string; slug: string }) =>
    request("POST", `/folders/${encodeURIComponent(id)}/rename`, { body, schema: folderRenameSchema }),
  moveFolder: (id: string, parentFolderId: string | null) =>
    request("POST", `/folders/${encodeURIComponent(id)}/move`, { body: { parentFolderId }, schema: folderMoveSchema }),
  transferFolderWorkspace: (id: string, workspaceId: string, parentFolderId: string | null) =>
    request("POST", `/folders/${encodeURIComponent(id)}/transfer-workspace`, { body: { workspaceId, parentFolderId }, schema: folderWorkspaceTransferSchema }),
  emptyFolder: (id: string, confirmationName: string) =>
    request("POST", `/folders/${encodeURIComponent(id)}/empty`, { body: { confirmationName }, schema: folderEmptySchema }),
  deleteFolder: (id: string) =>
    request("DELETE", `/folders/${encodeURIComponent(id)}`, { schema: okSchema }),

  // --- admin / management ---
  users: (workspaceId: string) =>
    request("GET", `/users?workspaceId=${encodeURIComponent(workspaceId)}`, { schema: usersListSchema }),
  createUser: (body: { workspaceId: string; email: string; name: string; password: string; role: "member" | "admin" | "viewer" | "guest" }) =>
    request("POST", "/users", { body, schema: userCreateSchema }),
  setMemberAuditAccess: (workspaceId: string, userId: string, canViewAudit: boolean) =>
    request("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/audit-access`, { body: { canViewAudit }, schema: okSchema }),
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
  grantDocumentPermission: (id: string, body: { email: string; role: PermissionInput["role"] }) =>
    request("POST", `/documents/${encodeURIComponent(id)}/permissions/grant`, { body, schema: permissionGrantSchema }),
  setDocumentPermissions: (id: string, permissions: PermissionInput[], version?: string) =>
    request("PUT", `/documents/${encodeURIComponent(id)}/permissions`, { body: { permissions, version }, schema: permissionsWriteSchema }),
  // Phase 3: per-row mutations drive optimistic UI without the bulk PUT.
  addDocumentPermission: (
    id: string,
    body: { subjectType: "user" | "group"; subjectId: string; role: PermissionInput["role"] },
  ) => request("POST", `/documents/${encodeURIComponent(id)}/permissions`, { body, schema: permissionRowResponseSchema }),
  updateDocumentPermission: (id: string, permissionId: string, role: PermissionInput["role"]) =>
    request(
      "PATCH",
      `/documents/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { body: { role }, schema: permissionRowResponseSchema },
    ),
  removeDocumentPermission: (id: string, permissionId: string) =>
    request(
      "DELETE",
      `/documents/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { schema: permissionDeleteResponseSchema },
    ),
  folderPermissions: (id: string) =>
    request("GET", `/folders/${encodeURIComponent(id)}/permissions`, { schema: permissionsListSchema }),
  grantFolderPermission: (id: string, body: { email: string; role: PermissionInput["role"] }) =>
    request("POST", `/folders/${encodeURIComponent(id)}/permissions/grant`, { body, schema: permissionGrantSchema }),
  setFolderPermissions: (id: string, permissions: PermissionInput[], version?: string) =>
    request("PUT", `/folders/${encodeURIComponent(id)}/permissions`, { body: { permissions, version }, schema: permissionsWriteSchema }),
  addFolderPermission: (
    id: string,
    body: { subjectType: "user" | "group"; subjectId: string; role: PermissionInput["role"] },
  ) => request("POST", `/folders/${encodeURIComponent(id)}/permissions`, { body, schema: permissionRowResponseSchema }),
  updateFolderPermission: (id: string, permissionId: string, role: PermissionInput["role"]) =>
    request(
      "PATCH",
      `/folders/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { body: { role }, schema: permissionRowResponseSchema },
    ),
  removeFolderPermission: (id: string, permissionId: string) =>
    request(
      "DELETE",
      `/folders/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { schema: permissionDeleteResponseSchema },
    ),
  setFolderDefaultRole: (id: string, defaultRole: "viewer" | "editor" | "manager" | null) =>
    request("PUT", `/folders/${encodeURIComponent(id)}/default-role`, { body: { defaultRole }, schema: folderDefaultRoleSchema }),
  // --- shares (Phase A2) ---
  createShare: (
    documentId: string,
    body: { ttlDays?: number; password?: string | null; allowIndexing?: boolean },
  ) =>
    request("POST", `/documents/${encodeURIComponent(documentId)}/share`, { body, schema: documentShareResponseSchema }),
  createFolderShare: (
    folderId: string,
    body: { ttlDays?: number; password?: string | null; allowIndexing?: boolean },
  ) =>
    request("POST", `/folders/${encodeURIComponent(folderId)}/share`, { body, schema: documentShareResponseSchema }),
  listShares: (
    workspaceId: string,
    opts: { documentId?: string; folderId?: string; includeRevoked?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.documentId) params.set("documentId", opts.documentId);
    if (opts.folderId) params.set("folderId", opts.folderId);
    if (opts.includeRevoked) params.set("includeRevoked", "true");
    const qs = params.toString();
    return request(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/shares${qs ? `?${qs}` : ""}`,
      { schema: documentShareListSchema },
    );
  },
  revokeShare: (shareId: string) =>
    request("DELETE", `/shares/${encodeURIComponent(shareId)}`, { schema: documentShareResponseSchema }),
  // --- agent edit scope (Phase C2) ---
  getAgentEditScope: (workspaceId: string) =>
    request("GET", `/workspaces/${encodeURIComponent(workspaceId)}/agent-edit-scope`, { schema: agentEditScopeSchema }),
  setAgentEditScope: (workspaceId: string, folderId: string | null) =>
    request("PUT", `/workspaces/${encodeURIComponent(workspaceId)}/agent-edit-scope`, { body: { folderId }, schema: agentEditScopeUpdateSchema }),
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

export interface ImportJob {
  id: string;
  workspaceId: string;
  status: "queued" | "running" | "done" | "failed";
  progress: { phase?: string; current?: number; total?: number; label?: string } | null;
  report: {
    foldersCreated?: number;
    documentsCreated?: number;
    documentsSkipped?: number;
    attachmentsUploaded?: number;
    attachmentWarnings?: string[];
    rows?: Array<{ path: string; status: "created" | "skipped" | "warning"; message: string }>;
  } | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
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
