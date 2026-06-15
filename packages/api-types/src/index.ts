// Scaffolded shared request/response types. Expand this package as endpoints are implemented;
// The wire `version` is a DocumentRevision id (opaque string). Roles are viewer|editor|manager.

export type Role = "viewer" | "editor" | "manager";
export type WorkspaceRole = "member" | "admin";
export type WorkspaceRoutingMode = "cloud_subdomain" | "custom_domain" | "self_hosted" | "explicit";
export type CustomDomainStatus = "pending" | "verified" | "active" | "failed";
export type ChangeSource = "web_app" | "obsidian_plugin" | "agent" | "import" | "system";
export type DocumentStatus = "canonical" | "draft" | "superseded" | "archived";

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
  status: DocumentStatus;
  updatedAt: string;
}

export interface DocumentRef {
  id: string;
  title: string;
  path: string;
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

export type ImplementationReadinessStatus =
  | "ready_to_implement"
  | "needs_contract_update"
  | "has_blocking_questions"
  | "conflicting_guidance"
  | "draft_only"
  | "superseded";

export interface ImplementationReadinessReason {
  code: string;
  severity: "blocking" | "warning" | "info";
  message: string;
}

export interface ImplementationReadiness {
  status: ImplementationReadinessStatus;
  reasons: ImplementationReadinessReason[];
}

export interface TaskPacket {
  summary: string;
  status: DocumentStatus;
  supersededBy: DocumentRef | null;
  currentPhase: string | null;
  nextSteps: string[];
  acceptanceCriteria: string[];
  tests: string[];
  nonGoals: string[];
  openQuestions: string[];
  relatedFiles: string[];
  decisions: string[];
  implementationReadiness: ImplementationReadiness;
}

export interface HandoffPacket {
  workspaceId: string;
  documentId: string;
  title: string;
  path: string;
  updatedAt: string;
  packet: TaskPacket;
}

export interface DocumentWithContent extends DocumentMeta {
  content: string;
  aiReadiness: AiReadiness;
  implementationReadiness: ImplementationReadiness;
  supersededBy: DocumentRef | null;
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

export interface RevisionSummary {
  id: string;
  versionNumber: number;
  checksum: string;
  createdBy: string;
  createdAt: string;
  changeSource: ChangeSource;
  message: string | null;
}

export interface RevisionDetail {
  revision: {
    id: string;
    documentId: string;
    versionNumber: number;
    content: string;
    checksum: string;
    createdBy: UserDTO & { avatarUrl: string | null };
    createdAt: string;
    changeSource: ChangeSource;
    message: string | null;
  };
  document: {
    id: string;
    currentTitle: string;
  };
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
