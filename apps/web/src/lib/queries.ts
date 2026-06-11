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

export const revisionsQuery = (id: string) =>
  queryOptions({ queryKey: ["revisions", id], queryFn: () => api.revisions(id) });

export const usersQuery = (workspaceId: string) =>
  queryOptions({ queryKey: ["users", workspaceId], queryFn: () => api.users(workspaceId) });

export const groupsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: ["groups", workspaceId], queryFn: () => api.groups(workspaceId) });

export const tokensQuery = () => queryOptions({ queryKey: ["tokens"], queryFn: () => api.tokens() });
