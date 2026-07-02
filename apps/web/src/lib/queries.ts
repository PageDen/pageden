import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

export const meQuery = queryOptions({ queryKey: ["me"], queryFn: api.me, retry: false, staleTime: 60_000 });

export const currentWorkspaceQuery = queryOptions({
  queryKey: ["workspaces", "current"],
  queryFn: api.currentWorkspace,
  retry: false,
  staleTime: 60_000,
});

export const treeQuery = (workspaceId: string) =>
  queryOptions({ queryKey: ["tree", workspaceId], queryFn: () => api.tree(workspaceId) });

export const searchQuery = (workspaceId: string, q: string) =>
  queryOptions({
    queryKey: ["search", workspaceId, q],
    queryFn: () => api.search(workspaceId, q),
  });

export const documentQuery = (id: string) =>
  queryOptions({ queryKey: ["document", id], queryFn: () => api.document(id) });

export const documentHandoffQuery = (id: string) =>
  queryOptions({ queryKey: ["document", id, "handoff"], queryFn: () => api.documentHandoff(id) });

export const documentRelatedDocsQuery = (id: string) =>
  queryOptions({
    queryKey: ["document", id, "related-docs"],
    queryFn: () => api.documentRelatedDocs(id),
    // Backlink scans touch the whole workspace, so cache longer than handoff.
    staleTime: 60_000,
  });

export const workspaceTransferSettingsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspace-transfer", "settings", workspaceId],
    queryFn: () => api.workspaceTransferSettings(workspaceId),
    retry: false,
    staleTime: 30_000,
  });

export const workspacePublicSharingSettingsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspace-public-sharing", "settings", workspaceId],
    queryFn: () => api.workspacePublicSharingSettings(workspaceId),
    retry: false,
    staleTime: 30_000,
  });

export const workspaceActivityQuery = (workspaceId: string) =>
  queryOptions({ queryKey: ["activity", workspaceId], queryFn: () => api.workspaceActivity(workspaceId) });

export const workspaceDashboardQuery = (workspaceId: string) =>
  queryOptions({ queryKey: ["dashboard", workspaceId], queryFn: () => api.workspaceDashboard(workspaceId) });

export const workspaceClaimsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["claims", workspaceId],
    queryFn: () => api.workspaceClaims(workspaceId),
    // Claims expire on a TTL; refetch on focus so a stale pip clears once a
    // sibling agent releases. A minute of stale data is fine.
    staleTime: 60_000,
  });

export const documentCommentsQuery = (documentId: string) =>
  queryOptions({ queryKey: ["document", documentId, "comments"], queryFn: () => api.documentComments(documentId) });

export const documentCommentMentionUsersQuery = (documentId: string) =>
  queryOptions({
    queryKey: ["document", documentId, "comment-mention-users"],
    queryFn: () => api.documentCommentMentionUsers(documentId),
    retry: false,
    staleTime: 60_000,
  });

export const revisionsQuery = (id: string) =>
  queryOptions({ queryKey: ["revisions", id], queryFn: () => api.revisions(id) });

export const documentHistoryQuery = (id: string) =>
  queryOptions({ queryKey: ["history", id], queryFn: () => api.documentHistory(id) });

export const documentDiffQuery = (id: string, fromVersion: string, toVersion: string) =>
  queryOptions({
    queryKey: ["document", id, "diff", fromVersion, toVersion],
    queryFn: () => api.documentDiff(id, fromVersion, toVersion),
  });

export const revisionDetailQuery = (id: string, revisionId: string) =>
  queryOptions({
    queryKey: ["revision", id, revisionId],
    queryFn: () => api.revisionDetail(id, revisionId),
  });

export const usersQuery = (workspaceId: string) =>
  queryOptions({ queryKey: ["users", workspaceId], queryFn: () => api.users(workspaceId) });

export const groupsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: ["groups", workspaceId], queryFn: () => api.groups(workspaceId) });

export const tokensQuery = () => queryOptions({ queryKey: ["tokens"], queryFn: () => api.tokens() });
