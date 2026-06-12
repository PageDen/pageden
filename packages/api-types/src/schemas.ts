import { z } from "zod";

// Runtime contract schemas — the single source of truth for response shapes.
// any unexpected/leaked fields (e.g. passwordHash, tokenHash).

export const roleSchema = z.enum(["viewer", "editor", "manager"]);
export const workspaceRoleSchema = z.enum(["member", "admin"]);
export const workspaceRoutingModeSchema = z.enum(["cloud_subdomain", "custom_domain", "self_hosted", "explicit"]);
export const customDomainStatusSchema = z.enum(["pending", "verified", "active", "failed"]);
export const changeSourceSchema = z.enum(["web_app", "obsidian_plugin", "agent", "import", "system"]);
const iso = z.string();

export const userDtoSchema = z.object({ id: z.string(), email: z.string(), name: z.string() }).strict();

export const workspaceDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().nullish(),
    subdomain: z.string().nullish(),
    customDomain: z.string().nullish(),
    customDomainStatus: customDomainStatusSchema.optional(),
    role: workspaceRoleSchema,
  })
  .strict();

export const publicWorkspaceDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().nullish(),
    subdomain: z.string().nullish(),
    customDomain: z.string().nullish(),
  })
  .strict();

export const currentWorkspaceSchema = z
  .object({ workspace: workspaceDtoSchema, routingMode: workspaceRoutingModeSchema })
  .strict();

export const publicCurrentWorkspaceSchema = z
  .object({ workspace: publicWorkspaceDtoSchema.nullable(), routingMode: workspaceRoutingModeSchema.nullable() })
  .strict();

export const meResponseSchema = z
  .object({ user: userDtoSchema, emailVerified: z.boolean(), workspaces: z.array(workspaceDtoSchema) })
  .strict();

export const okSchema = z.object({ ok: z.literal(true) }).strict();
export const authConfigSchema = z
  .object({
    googleEnabled: z.boolean(),
    captcha: z.object({ provider: z.literal("turnstile"), siteKey: z.string() }).strict().nullable(),
  })
  .strict();
export const okDeletedSchema = z.object({ ok: z.literal(true), deletedAt: iso }).strict();

// Tokens
export const tokenCreateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    scopes: z.array(z.string()),
    workspaceId: z.string().nullable(),
    token: z.string(),
    expiresAt: iso.nullable(),
    createdAt: iso,
  })
  .strict();
export const tokenListSchema = z
  .object({
    tokens: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          kind: z.string(),
          scopes: z.array(z.string()),
          workspaceId: z.string().nullable(),
          lastUsedAt: iso.nullable(),
          lastUsedIp: z.string().nullable(),
          expiresAt: iso.nullable(),
          createdAt: iso,
          revokedAt: iso.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// Documents
export const documentMetaSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    folderId: z.string(),
    path: z.string(),
    title: z.string(),
    permission: roleSchema,
    version: z.string().nullable(),
    checksum: z.string().nullable(),
    updatedAt: iso,
  })
  .strict();

export const documentListSchema = z.object({ documents: z.array(documentMetaSchema) }).strict();

export const treeSchema = z
  .object({
    folders: z.array(
      z
        .object({
          id: z.string(),
          parentFolderId: z.string().nullable(),
          name: z.string(),
          slug: z.string(),
          path: z.string(),
          permission: roleSchema.nullable(),
        })
        .strict(),
    ),
    documents: z.array(
      z
        .object({
          id: z.string(),
          folderId: z.string(),
          title: z.string(),
          path: z.string(),
          permission: roleSchema,
          version: z.string().nullable(),
          checksum: z.string().nullable(),
          updatedAt: iso,
        })
        .strict(),
    ),
  })
  .strict();

export const aiReadinessIssueSchema = z
  .object({
    code: z.string(),
    severity: z.enum(["info", "warning"]),
    message: z.string(),
  })
  .strict();

export const aiReadinessSchema = z
  .object({
    status: z.enum(["ready", "usable", "needs_attention"]),
    score: z.number(),
    issues: z.array(aiReadinessIssueSchema),
  })
  .strict();

export const documentWithContentSchema = documentMetaSchema
  .extend({
    content: z.string(),
    aiReadiness: aiReadinessSchema,
  })
  .strict();

export const documentCreateSchema = z
  .object({ id: z.string(), version: z.string(), checksum: z.string(), path: z.string() })
  .strict();

export const writeResultSchema = z
  .object({ id: z.string(), version: z.string(), checksum: z.string(), updatedAt: iso })
  .strict();

export const documentRenameSchema = z.object({ id: z.string(), path: z.string() }).strict();
export const documentMoveSchema = z.object({ id: z.string(), folderId: z.string(), path: z.string() }).strict();

export const revisionsSchema = z
  .object({
    revisions: z.array(
      z
        .object({
          id: z.string(),
          versionNumber: z.number(),
          checksum: z.string(),
          createdBy: z.string(),
          createdAt: iso,
          changeSource: changeSourceSchema,
          message: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// Folders
export const folderCreateSchema = z.object({ id: z.string(), path: z.string() }).strict();
export const folderRenameSchema = z.object({ id: z.string(), path: z.string() }).strict();
export const folderMoveSchema = z
  .object({ id: z.string(), parentFolderId: z.string().nullable(), path: z.string() })
  .strict();

// Permissions
export const permissionsListSchema = z
  .object({
    version: z.string(),
    permissions: z.array(
      z
        .object({ id: z.string(), subjectType: z.enum(["user", "group"]), subjectId: z.string(), role: roleSchema })
        .strict(),
    ),
  })
  .strict();

export const permissionsWriteSchema = z.object({ ok: z.literal(true), version: z.string() }).strict();

// Admin
export const workspacesSchema = z.object({ workspaces: z.array(workspaceDtoSchema) }).strict();
export const workspaceAvailabilitySchema = z
  .object({ available: z.boolean(), subdomain: z.string(), reason: z.string().nullable() })
  .strict();
export const workspaceCreateSchema = z.object({ workspace: workspaceDtoSchema }).strict();
export const usersListSchema = z
  .object({
    users: z.array(
      z.object({ id: z.string(), email: z.string(), name: z.string(), role: workspaceRoleSchema }).strict(),
    ),
  })
  .strict();
export const userCreateSchema = z
  .object({ id: z.string(), email: z.string(), name: z.string(), role: workspaceRoleSchema })
  .strict();
export const groupsListSchema = z
  .object({ groups: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() }).strict()) })
  .strict();
export const groupCreateSchema = z.object({ id: z.string(), name: z.string(), slug: z.string() }).strict();
export const auditSchema = z
  .object({
    events: z.array(
      z
        .object({
          id: z.string(),
          userId: z.string().nullable(),
          action: z.string(),
          targetType: z.string(),
          targetId: z.string().nullable(),
          ipAddress: z.string().nullable(),
          createdAt: iso,
          metadata: z.unknown().nullable(),
        })
        .strict(),
    ),
    nextBefore: z.string().nullable(),
  })
  .strict();

// Errors
export const validationErrorSchema = z
  .object({ error: z.literal("validation_error"), fields: z.record(z.string()) })
  .strict();
export const forbiddenSchema = z.object({ error: z.literal("forbidden"), message: z.string() }).strict();
export const notFoundSchema = z.object({ error: z.literal("not_found"), message: z.string() }).strict();
export const unauthorizedSchema = z.object({ error: z.literal("unauthorized"), message: z.string() }).strict();
export const conflictSchema = z
  .object({ error: z.literal("conflict"), currentVersion: z.string(), message: z.string() })
  .strict();

// Device-code login (M6)
export const deviceStartSchema = z
  .object({
    deviceCode: z.string(),
    userCode: z.string(),
    verificationUri: z.string(),
    expiresIn: z.number(),
    interval: z.number(),
  })
  .strict();

export const devicePollSchema = z.union([
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z.object({ status: z.literal("consumed") }).strict(),
  z.object({ status: z.literal("approved"), token: z.string() }).strict(),
]);

export const deviceLookupSchema = z
  .object({ ipAddress: z.string().nullable(), createdAt: z.string() })
  .strict();

export const searchSchema = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          path: z.string(),
          permission: roleSchema,
          // Highlighted body excerpt; null when the match was on the title only. Highlight spans
          // are delimited by U+E000/U+E001 (private-use) so clients escape text then bold spans.
          snippet: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const reindexResultSchema = z.object({ reindexed: z.number(), skipped: z.number() }).strict();

// Attachments (M6)
export const attachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    size: z.number(),
    sha256: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const attachmentListSchema = z.object({ attachments: z.array(attachmentSchema) }).strict();
