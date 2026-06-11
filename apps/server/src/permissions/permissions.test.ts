import { describe, it, expect } from "vitest";
import {
  atLeast,
  canEditDocument,
  canManageDocument,
  canManageWorkspace,
  resolveDocumentRole,
  strongest,
} from "./index.js";

interface FakePermissionWhere {
  workspaceId: string;
  resourceType: "folder" | "document";
  resourceId: string | { in: string[] };
  OR: Array<{ subjectType: "user" | "group"; subjectId: string }>;
}

describe("permission ranking", () => {
  it("picks the strongest role", () => {
    expect(strongest(["viewer", "manager", "editor"])).toBe("manager");
    expect(strongest(["viewer"])).toBe("viewer");
    expect(strongest([])).toBeNull();
  });

  it("atLeast respects the hierarchy", () => {
    expect(atLeast("editor", "viewer")).toBe(true);
    expect(atLeast("viewer", "editor")).toBe(false);
    expect(atLeast(null, "viewer")).toBe(false);
  });
});

interface FakePermission {
  workspaceId: string;
  subjectType: "user" | "group";
  subjectId: string;
  resourceType: "folder" | "document";
  resourceId: string;
  role: "viewer" | "editor" | "manager";
}

function fakeClient(input: {
  document?: { id: string; workspaceId: string; folderId: string };
  workspaceRole?: "member" | "admin" | null;
  groupIds?: string[];
  folders?: Record<string, { id: string; parentFolderId: string | null }>;
  permissions?: FakePermission[];
}) {
  return {
    document: {
      findFirst: async () => input.document ?? null,
    },
    workspaceMembership: {
      findUnique: async () => (input.workspaceRole ? { role: input.workspaceRole } : null),
    },
    groupMembership: {
      findMany: async () => (input.groupIds ?? []).map((groupId) => ({ groupId })),
    },
    folder: {
      findFirst: async ({ where }: { where: { id: string } }) => input.folders?.[where.id] ?? null,
    },
    permission: {
      findMany: async ({ where }: { where: FakePermissionWhere }) => {
        const subjects = where.OR;
        const resourceIds =
          typeof where.resourceId === "object" && "in" in where.resourceId
            ? where.resourceId.in
            : [where.resourceId as string];
        return (input.permissions ?? []).filter(
          (permission) =>
            permission.workspaceId === where.workspaceId &&
            permission.resourceType === where.resourceType &&
            resourceIds.includes(permission.resourceId) &&
            subjects.some(
              (subject) =>
                subject.subjectType === permission.subjectType && subject.subjectId === permission.subjectId,
            ),
        );
      },
    },
  } as unknown as Parameters<typeof resolveDocumentRole>[2];
}

describe("permission resolution", () => {
  it("treats workspace admin as document manager", async () => {
    const client = fakeClient({
      document: { id: "doc_1", workspaceId: "workspace_1", folderId: "folder_1" },
      workspaceRole: "admin",
    });

    await expect(resolveDocumentRole("user_1", "doc_1", client)).resolves.toBe("manager");
    await expect(canManageDocument("user_1", "doc_1", client)).resolves.toBe(true);
  });

  it("resolves inherited folder and group grants", async () => {
    const client = fakeClient({
      document: { id: "doc_1", workspaceId: "workspace_1", folderId: "child" },
      workspaceRole: "member",
      groupIds: ["group_1"],
      folders: {
        child: { id: "child", parentFolderId: "parent" },
        parent: { id: "parent", parentFolderId: null },
      },
      permissions: [
        {
          workspaceId: "workspace_1",
          subjectType: "group",
          subjectId: "group_1",
          resourceType: "folder",
          resourceId: "parent",
          role: "editor",
        },
      ],
    });

    await expect(resolveDocumentRole("user_1", "doc_1", client)).resolves.toBe("editor");
    await expect(canEditDocument("user_1", "doc_1", client)).resolves.toBe(true);
  });

  it("uses strongest role across document overrides and inherited grants", async () => {
    const client = fakeClient({
      document: { id: "doc_1", workspaceId: "workspace_1", folderId: "folder_1" },
      workspaceRole: "member",
      folders: { folder_1: { id: "folder_1", parentFolderId: null } },
      permissions: [
        {
          workspaceId: "workspace_1",
          subjectType: "user",
          subjectId: "user_1",
          resourceType: "folder",
          resourceId: "folder_1",
          role: "viewer",
        },
        {
          workspaceId: "workspace_1",
          subjectType: "user",
          subjectId: "user_1",
          resourceType: "document",
          resourceId: "doc_1",
          role: "manager",
        },
      ],
    });

    await expect(resolveDocumentRole("user_1", "doc_1", client)).resolves.toBe("manager");
  });

  it("checks workspace manager rights directly", async () => {
    await expect(canManageWorkspace("user_1", "workspace_1", fakeClient({ workspaceRole: "admin" }))).resolves.toBe(
      true,
    );
    await expect(canManageWorkspace("user_1", "workspace_1", fakeClient({ workspaceRole: "member" }))).resolves.toBe(
      false,
    );
  });
});
