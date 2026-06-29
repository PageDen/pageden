import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  documentRevisionFindMany: vi.fn(),
  attachmentFindMany: vi.fn(),
  removeStorageKey: vi.fn(),
  removeStoragePrefix: vi.fn(),
}));

vi.mock("./prisma.js", () => ({
  prisma: {
    $transaction: mocks.transaction,
    user: { findUniqueOrThrow: mocks.userFindUniqueOrThrow },
    documentRevision: { findMany: mocks.documentRevisionFindMany },
    attachment: { findMany: mocks.attachmentFindMany },
  },
}));

vi.mock("./storage.js", () => ({
  removeStorageKey: mocks.removeStorageKey,
  removeStoragePrefix: mocks.removeStoragePrefix,
}));

import {
  ACCOUNT_DELETION_CODE_TTL_MS,
  accountDeletionPreview,
  createAccountDeletionCode,
  deleteAccountAndData,
  generateAccountDeletionCode,
  hashAccountDeletionCode,
} from "./account-deletion.js";

function txMock() {
  return {
    accountDeletionCode: { updateMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    user: { upsert: vi.fn().mockResolvedValue({ id: "deleted_user" }), delete: vi.fn() },
    folder: { updateMany: vi.fn() },
    document: { updateMany: vi.fn() },
    documentRevision: { updateMany: vi.fn() },
    attachment: { updateMany: vi.fn() },
    documentComment: { updateMany: vi.fn() },
    documentShare: { updateMany: vi.fn() },
    documentClaim: { deleteMany: vi.fn() },
    permission: { deleteMany: vi.fn() },
    deviceAuthRequest: { deleteMany: vi.fn() },
    workspace: { deleteMany: vi.fn() },
  };
}

describe("account deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (fn: (tx: ReturnType<typeof txMock>) => Promise<void>) => fn(txMock()));
    mocks.removeStoragePrefix.mockResolvedValue(2);
    mocks.removeStorageKey.mockResolvedValue(undefined);
  });

  it("generates and hashes six-digit confirmation codes", () => {
    const code = generateAccountDeletionCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(hashAccountDeletionCode("user_1", "123456")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashAccountDeletionCode("user_1", "123456")).toBe(hashAccountDeletionCode("user_1", "123456"));
  });

  it("previews solo and shared workspaces", async () => {
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      email: "me@example.com",
      workspaceMemberships: [
        { workspace: { id: "solo", name: "Solo", _count: { members: 1 } } },
        { workspace: { id: "shared", name: "Shared", _count: { members: 3 } } },
      ],
    });

    await expect(accountDeletionPreview("user_1")).resolves.toEqual({
      userEmail: "me@example.com",
      soleWorkspaces: [{ id: "solo", name: "Solo" }],
      sharedWorkspaces: [{ id: "shared", name: "Shared", otherMemberCount: 2 }],
    });
  });

  it("expires previous codes before creating the next one", async () => {
    const tx = txMock();
    mocks.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof txMock>) => Promise<void>) => fn(tx));

    const before = Date.now();
    const expiresAt = await createAccountDeletionCode("user_1", "123456", "127.0.0.1");

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ACCOUNT_DELETION_CODE_TTL_MS);
    expect(tx.accountDeletionCode.updateMany).toHaveBeenCalledWith({
      where: { userId: "user_1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(tx.accountDeletionCode.create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        codeHash: hashAccountDeletionCode("user_1", "123456"),
        expiresAt,
        ipAddress: "127.0.0.1",
      },
    });
  });

  it("deletes solo workspaces, preserves shared records, and cleans unreferenced storage", async () => {
    const tx = txMock();
    mocks.transaction.mockImplementationOnce(async (fn: (tx: ReturnType<typeof txMock>) => Promise<void>) => fn(tx));
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      email: "me@example.com",
      workspaceMemberships: [
        { workspace: { id: "solo", name: "Solo", _count: { members: 1 } } },
        { workspace: { id: "shared", name: "Shared", _count: { members: 2 } } },
      ],
    });
    mocks.documentRevisionFindMany
      .mockResolvedValueOnce([{ storageKey: "objects/legacy-rev.md" }, { storageKey: "workspaces/solo/objects/current.md" }])
      .mockResolvedValueOnce([{ storageKey: "objects/legacy-rev.md" }]);
    mocks.attachmentFindMany.mockResolvedValueOnce([{ storageKey: "attachments/legacy.bin" }]).mockResolvedValueOnce([]);

    await expect(deleteAccountAndData("user_1")).resolves.toEqual({ deletedWorkspaces: 1, removedStorageObjects: 3 });

    expect(tx.user.upsert).toHaveBeenCalledWith({
      where: { email: "deleted-user@pageden.system" },
      update: {},
      create: { email: "deleted-user@pageden.system", name: "Deleted user", passwordHash: null, emailVerified: true },
      select: { id: true },
    });
    expect(tx.document.updateMany).toHaveBeenCalledWith({ where: { createdById: "user_1" }, data: { createdById: "deleted_user" } });
    expect(tx.documentShare.updateMany).toHaveBeenCalledWith({ where: { createdById: "user_1" }, data: { createdById: "deleted_user" } });
    expect(tx.permission.deleteMany).toHaveBeenCalledWith({ where: { userId: "user_1" } });
    expect(tx.workspace.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["solo"] } } });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: "user_1" } });
    expect(mocks.removeStoragePrefix).toHaveBeenCalledWith("workspaces/solo/");
    expect(mocks.removeStorageKey).toHaveBeenCalledWith("attachments/legacy.bin");
    expect(mocks.removeStorageKey).not.toHaveBeenCalledWith("objects/legacy-rev.md");
  });
});
