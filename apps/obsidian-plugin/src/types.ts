import type { Role } from "@pageden/api-types";

export interface PagedenSettings {
  serverUrl: string;
  token: string;
  workspaceId: string;
  remoteDocsFolder: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  userName?: string;
  workspaceName?: string;
}

export interface MeResponse {
  user: { id: string; email: string; name: string };
  workspaces: { id: string; name: string; role: string }[];
}

export interface RemoteFolder {
  id: string;
  parentFolderId: string | null;
  name: string;
  slug: string;
  path: string;
  permission: Role | null;
}

export interface RemoteDocument {
  id: string;
  folderId: string;
  title: string;
  path: string;
  permission: Role;
  version: string | null;
  checksum: string | null;
}

export interface RemoteTree {
  folders: RemoteFolder[];
  documents: RemoteDocument[];
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  permission: Role;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface RemoteDocumentWithContent extends RemoteDocument {
  workspaceId: string;
  content: string;
  updatedAt: string;
}

export interface CreateFolderResponse {
  id: string;
  path: string;
}

export interface CreateDocumentResponse {
  id: string;
  version: string;
  checksum: string;
  path: string;
}

export interface ServerMetaEntry {
  documentId: string;
  localPath: string;
  remotePath: string;
  title: string;
  baseVersion: string;
  checksum: string;
  permission: Role;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export interface AttachmentListResponse {
  attachments: Attachment[];
}

export interface ServerMetaAttachmentEntry {
  attachmentId: string;
  documentId: string;
  localPath: string;
  filename: string;
  sha256: string;
  size: number;
  contentType: string;
  createdAt: string;
}

export interface ServerMetaFile {
  documents: Record<string, ServerMetaEntry>;
  attachments?: Record<string, ServerMetaAttachmentEntry>;
}

export interface WriteResult {
  id: string;
  version: string;
  checksum: string;
  updatedAt: string;
}

export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResponse =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "approved"; token: string };
