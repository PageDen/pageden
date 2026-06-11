// Scaffolded shared request/response types. Expand this package as endpoints are implemented;
// The wire `version` is a DocumentRevision id (opaque string). Roles are viewer|editor|manager.

export type Role = "viewer" | "editor" | "manager";
export type WorkspaceRole = "member" | "admin";
export type WorkspaceRoutingMode = "cloud_subdomain" | "custom_domain" | "self_hosted" | "explicit";
export type CustomDomainStatus = "pending" | "verified" | "active" | "failed";
export type ChangeSource = "web_app" | "obsidian_plugin" | "agent" | "import" | "system";

export interface UserDTO {
  id: string;
  email: string;
  name: string;
}

export interface WorkspaceDTO {
  id: string;
  name: string;
  slug?: string;
  subdomain?: string | null;
  customDomain?: string | null;
  customDomainStatus?: CustomDomainStatus;
  role: WorkspaceRole;
}

export interface PublicWorkspaceDTO {
  id: string;
  name: string;
  slug?: string;
  subdomain?: string | null;
  customDomain?: string | null;
}

export interface CurrentWorkspaceResponse {
  workspace: WorkspaceDTO;
  routingMode: WorkspaceRoutingMode;
}

export interface PublicCurrentWorkspaceResponse {
  workspace: PublicWorkspaceDTO | null;
  routingMode: WorkspaceRoutingMode | null;
}

export interface MeResponse {
  user: UserDTO;
  workspaces: WorkspaceDTO[];
}

export interface DocumentMeta {
  id: string;
  workspaceId: string;
  folderId: string;
  path: string;
  title: string;
  permission: Role;
  version: string | null; // DocumentRevision id
  checksum: string | null; // "sha256:..."
  updatedAt: string;
}

export interface AiReadinessIssue {
  code: string;
  severity: "info" | "warning";
  message: string;
}

export interface AiReadiness {
  status: "ready" | "usable" | "needs_attention";
  score: number;
  issues: AiReadinessIssue[];
}

export interface DocumentWithContent extends DocumentMeta {
  content: string;
  aiReadiness: AiReadiness;
}

export interface PushRequest {
  baseVersion: string;
  checksum: string;
  content: string;
}

export interface WriteResult {
  id: string;
  version: string;
  checksum: string;
  updatedAt: string;
}

export interface ConflictError {
  error: "conflict";
  currentVersion: string;
  message: string;
}

export interface ValidationError {
  error: "validation_error";
  fields: Record<string, string>;
}

export interface ForbiddenError {
  error: "forbidden";
  message: string;
}

export interface NotFoundError {
  error: "not_found";
  message: string;
}

export type ApiError = ConflictError | ValidationError | ForbiddenError | NotFoundError;

export * from "./schemas.js";
