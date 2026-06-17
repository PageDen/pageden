import { z } from "zod";

// Runtime contract schemas — the single source of truth for response shapes.
// any unexpected/leaked fields (e.g. passwordHash, tokenHash).

export const roleSchema = z.enum(["viewer", "editor", "manager"]);
export const workspaceRoleSchema = z.enum(["guest", "viewer", "member", "admin"]);
export const workspaceRoutingModeSchema = z.enum(["cloud_subdomain", "custom_domain", "self_hosted", "explicit"]);
export const customDomainStatusSchema = z.enum(["pending", "verified", "active", "failed"]);
export const changeSourceSchema = z.enum(["web_app", "obsidian_plugin", "agent", "import", "system"]);
export const documentStatusSchema = z.enum(["canonical", "draft", "superseded", "archived"]);
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
    status: documentStatusSchema,
    updatedAt: iso,
  })
  .strict();

export const documentListSchema = z.object({ documents: z.array(documentMetaSchema) }).strict();

// Capability map serialized per document so the frontend can show/hide actions
// without re-deriving the role → action matrix. Permission stays as the raw
// role; capabilities is the rendered policy.
export const capabilitiesSchema = z
  .object({
    canView: z.boolean(),
    canEdit: z.boolean(),
    canDelete: z.boolean(),
    canManage: z.boolean(),
    canComment: z.boolean(),
    canShare: z.boolean(),
  })
  .strict();

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
          defaultRole: roleSchema.nullable(),
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
          capabilities: capabilitiesSchema,
          version: z.string().nullable(),
          checksum: z.string().nullable(),
          status: documentStatusSchema,
          updatedAt: iso,
        })
        .strict(),
    ),
  })
  .strict();

export const folderDefaultRoleSchema = z.object({ id: z.string(), defaultRole: roleSchema.nullable() }).strict();

export const agentEditScopeSchema = z
  .object({
    workspaceId: z.string(),
    agentEditScopeFolderId: z.string().nullable(),
    agentEditScopeFolder: z
      .object({ id: z.string(), path: z.string(), name: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

export const agentEditScopeUpdateSchema = z
  .object({ workspaceId: z.string(), agentEditScopeFolderId: z.string().nullable() })
  .strict();

export const documentShareSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    documentId: z.string(),
    slug: z.string(),
    hasPassword: z.boolean(),
    allowIndexing: z.boolean(),
    expiresAt: iso.nullable(),
    revokedAt: iso.nullable(),
    createdById: z.string(),
    createdAt: iso,
    updatedAt: iso,
    active: z.boolean(),
  })
  .strict();

export const documentShareResponseSchema = z.object({ share: documentShareSchema }).strict();
export const documentShareListSchema = z.object({ workspaceId: z.string(), shares: z.array(documentShareSchema) }).strict();
export const publicShareSchema = z
  .object({
    title: z.string(),
    path: z.string(),
    content: z.string(),
    share: z.object({ slug: z.string(), allowIndexing: z.boolean(), expiresAt: iso.nullable() }).strict(),
  })
  .strict();

export const documentRefSchema = z.object({ id: z.string(), title: z.string(), path: z.string() }).strict();

// Typed related-docs panel. Each list is filtered through the workspace
// resolver server-side, so private docs the caller cannot read never appear.
const relatedDocRefSchema = documentRefSchema.extend({ status: z.string() }).strict();
export const relatedDocsSchema = z
  .object({
    documentId: z.string(),
    workspaceId: z.string(),
    supersedes: z.array(relatedDocRefSchema),
    supersededBy: relatedDocRefSchema.nullable(),
    references: z.array(relatedDocRefSchema),
    referencedBy: z.array(relatedDocRefSchema),
    prLinks: z.array(z.string()),
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

export const implementationReadinessStatusSchema = z.enum([
  "ready_to_implement",
  "needs_contract_update",
  "has_blocking_questions",
  "conflicting_guidance",
  "draft_only",
  "superseded",
  "not_applicable",
]);

export const implementationReadinessReasonSchema = z
  .object({
    code: z.string(),
    severity: z.enum(["blocking", "warning", "info"]),
    message: z.string(),
  })
  .strict();

export const implementationReadinessSchema = z
  .object({
    status: implementationReadinessStatusSchema,
    score: z.number(),
    reasons: z.array(implementationReadinessReasonSchema),
  })
  .strict();

export const decisionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    date: z.string().nullable(),
    owner: z.string().nullable(),
    replaces: z.string().nullable(),
    decision: z.string(),
    reason: z.string(),
  })
  .strict();

export const taskPacketSchema = z
  .object({
    summary: z.string(),
    status: documentStatusSchema,
    supersededBy: documentRefSchema.nullable(),
    currentPhase: z.string().nullable(),
    nextSteps: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    tests: z.array(z.string()),
    nonGoals: z.array(z.string()),
    openQuestions: z.array(z.string()),
    relatedFiles: z.array(z.string()),
    decisions: z.array(decisionSchema),
    prLinks: z.array(z.string()),
    implementationReadiness: implementationReadinessSchema,
  })
  .strict();

export const activityEventSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable(),
    userId: z.string().nullable(),
    actor: z.enum(["user", "agent", "system", "obsidian_plugin", "unknown"]),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string().nullable(),
    documentTitle: z.string().nullable(),
    documentPath: z.string().nullable(),
    createdAt: iso,
    metadata: z.unknown().nullable(),
  })
  .strict();

export const activityFeedSchema = z
  .object({
    workspaceId: z.string(),
    events: z.array(activityEventSchema),
    nextBefore: z.string().nullable(),
  })
  .strict();

export const documentCommentSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    documentId: z.string(),
    sectionAnchor: z.string().nullable(),
    body: z.string(),
    authorUserId: z.string().nullable(),
    authorTokenId: z.string().nullable(),
    authorLabel: z.string().nullable(),
    resolvedAt: iso.nullable(),
    resolvedById: z.string().nullable(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict();

export const documentCommentsListSchema = z.object({ comments: z.array(documentCommentSchema) }).strict();
export const documentCommentResponseSchema = z.object({ comment: documentCommentSchema }).strict();

export const documentClaimSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    documentId: z.string(),
    tokenId: z.string().nullable(),
    userId: z.string().nullable(),
    actorLabel: z.string().nullable(),
    note: z.string().nullable(),
    expiresAt: iso,
    releasedAt: iso.nullable(),
    active: z.boolean(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict();

export const documentClaimWithDocSchema = documentClaimSchema
  .extend({
    document: z.object({ id: z.string(), title: z.string(), path: z.string() }).strict(),
  })
  .strict();

export const workspaceClaimsListSchema = z
  .object({ workspaceId: z.string(), claims: z.array(documentClaimWithDocSchema) })
  .strict();

export const dashboardStatsSchema = z
  .object({
    workspaceId: z.string(),
    totals: z
      .object({ folders: z.number(), documents: z.number(), openComments: z.number() })
      .strict(),
    statusCounts: z
      .object({
        canonical: z.number(),
        draft: z.number(),
        superseded: z.number(),
        archived: z.number(),
      })
      .strict(),
    supersededDocs: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          path: z.string(),
          supersededBy: documentRefSchema.nullable(),
        })
        .strict(),
    ),
    recentChanges: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          path: z.string(),
          status: documentStatusSchema,
          updatedAt: iso,
        })
        .strict(),
    ),
    recentActivity: z.array(activityEventSchema),
    topFolders: z.array(
      z
        .object({
          id: z.string(),
          path: z.string(),
          name: z.string(),
          documentCount: z.number(),
        })
        .strict(),
    ),
    activeClaims: z.array(documentClaimWithDocSchema),
  })
  .strict();

export const handoffPacketSchema = z
  .object({
    workspaceId: z.string(),
    documentId: z.string(),
    title: z.string(),
    path: z.string(),
    updatedAt: iso,
    packet: taskPacketSchema,
  })
  .strict();

export const documentWithContentSchema = documentMetaSchema
  .extend({
    content: z.string(),
    aiReadiness: aiReadinessSchema,
    implementationReadiness: implementationReadinessSchema,
    supersededBy: documentRefSchema.nullable(),
    capabilities: capabilitiesSchema,
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
          contributorIds: z.array(z.string()),
          isPinned: z.boolean(),
          label: z.string().nullable(),
          groupId: z.string(),
          groupCount: z.number(),
          groupStartVersionNumber: z.number(),
          groupEndVersionNumber: z.number(),
          collapsedRevisions: z.array(
            z
              .object({
                id: z.string(),
                versionNumber: z.number(),
                checksum: z.string(),
                createdBy: z.string(),
                createdAt: iso,
                changeSource: changeSourceSchema,
                message: z.string().nullable(),
                contributorIds: z.array(z.string()),
                isPinned: z.boolean(),
                label: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export const documentHistorySchema = z
  .object({
    revisions: revisionsSchema.shape.revisions,
    timeline: z.array(
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("revision"),
            id: z.string(),
            createdAt: iso,
            revision: revisionsSchema.shape.revisions.element,
          })
          .strict(),
        z
          .object({
            type: z.literal("event"),
            id: z.string(),
            createdAt: iso,
            event: z
              .object({
                action: z.string(),
                actor: z.enum(["user", "agent", "system", "obsidian_plugin", "unknown"]),
                userId: z.string().nullable(),
                targetType: z.string(),
                targetId: z.string().nullable(),
                metadata: z.unknown().nullable(),
              })
              .strict(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

export const revisionDetailSchema = z
  .object({
    revision: z
      .object({
        id: z.string(),
        documentId: z.string(),
        versionNumber: z.number(),
        content: z.string(),
        checksum: z.string(),
        createdBy: z
          .object({
            id: z.string(),
            name: z.string(),
            email: z.string(),
            avatarUrl: z.string().nullable(),
          })
          .strict(),
        createdAt: iso,
        changeSource: changeSourceSchema,
        message: z.string().nullable(),
        contributorIds: z.array(z.string()),
        isPinned: z.boolean(),
        label: z.string().nullable(),
      })
      .strict(),
    document: z.object({ id: z.string(), currentTitle: z.string() }).strict(),
  })
  .strict();

// Folders
export const folderCreateSchema = z.object({ id: z.string(), path: z.string() }).strict();
export const folderRenameSchema = z.object({ id: z.string(), path: z.string() }).strict();
export const folderMoveSchema = z
  .object({ id: z.string(), parentFolderId: z.string().nullable(), path: z.string() })
  .strict();

// Permissions
const permissionGranteeSchema = z
  .object({
    id: z.string(),
    subjectType: z.enum(["user", "group"]),
    subjectId: z.string(),
    role: roleSchema,
    subject: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("user"), id: z.string(), email: z.string(), name: z.string() }).strict(),
        z.object({ type: z.literal("group"), id: z.string(), name: z.string(), slug: z.string() }).strict(),
      ])
      .nullable(),
  })
  .strict();

const inheritedPermissionSchema = permissionGranteeSchema.extend({
  inheritedFrom: z
    .object({
      folderId: z.string(),
      folderPath: z.string(),
      folderName: z.string(),
    })
    .strict(),
}).strict();

export const permissionsListSchema = z
  .object({
    version: z.string(),
    permissions: z.array(permissionGranteeSchema),
    inheritedPermissions: z.array(inheritedPermissionSchema),
  })
  .strict();

export const permissionsWriteSchema = z.object({ ok: z.literal(true), version: z.string() }).strict();

// Per-row create/update responses for the Phase 3 optimistic mutations.
export const permissionRowResponseSchema = z
  .object({ ok: z.literal(true), permission: permissionGranteeSchema })
  .strict();
export const permissionDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export const permissionGrantSchema = z
  .object({
    ok: z.literal(true),
    version: z.string(),
    membershipCreated: z.boolean(),
    permission: z
      .object({ subjectType: z.literal("user"), subjectId: z.string(), role: roleSchema })
      .strict(),
    user: userDtoSchema,
  })
  .strict();

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
          status: documentStatusSchema,
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
