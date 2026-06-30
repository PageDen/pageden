import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { writeAuditEvent } from "../audit.js";
import { authenticate, requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { checksum as computeChecksum } from "../checksum.js";
import { lockFolderTree } from "../db.js";
import { env } from "../env.js";
import { isUniqueViolation } from "../errors.js";
import { atLeast, authorizeFolderRole, canManageWorkspace, enforceAgentEditScope, resolveDocumentRole, resolveFolderRole } from "../permissions/index.js";
import { buildWorkspaceResolver } from "../permissions/resolver.js";
import { buildDocumentPath, buildFolderPath, isValidSlug } from "../paths.js";
import { prisma } from "../prisma.js";
import { readContent, writeContent } from "../storage.js";
import { applyDocumentWrite, buildHandoffPacket, metadataFromContent, searchTextFor } from "../documents/routes.js";
import { searchDocuments as runSearchDocuments, SEARCH_QUERY_MAX, type SearchDocumentsResult } from "../search/service.js";
import { extractDecisions, extractSections, findSection, implementationReadinessFor } from "../documents/handoff.js";
import { extractMarkdownHeadings } from "../documents/headings.js";
import { documentRelationships } from "../documents/relationships.js";
import { replaceSection, suggestAnchors } from "../documents/sections.js";
import { brokenLinkExplanation, lintWikilinks, rewriteWikilinks, type RewriteReplacement } from "../documents/wikilinks.js";
import { documentStatsFor } from "../documents/stats.js";
import { documentDiffFor } from "../documents/diff.js";
import { workspaceActivityFor } from "../workspaces/insights.js";
import { createComment, listComments, resolveCommentRecord } from "../documents/comments.js";
import { touchReadCursor, unreadDocuments } from "../documents/read-cursors.js";
import { claimDocument, listActiveClaims, releaseClaim } from "../documents/claims.js";
import { createShare, listShares, revokeShare } from "../documents/shares.js";
import { aiReadinessForDocument, documentContext } from "../ai-readiness.js";
import { trackServerEvent } from "../lib/analytics-bus.js";
import { ALLOWED_MIME_TYPES as ATTACHMENT_ALLOWED_MIME, MAX_ATTACHMENT_BYTES, createDocumentAttachment } from "../attachments/routes.js";
import { signUploadGrant, UPLOAD_GRANT_TTL_SECONDS } from "../attachments/upload-grant.js";
import { requestHost } from "../workspaces/domains.js";

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type McpContent = { type: "text"; text: string };
type Tx = Prisma.TransactionClient;
type McpToolAnnotations = {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const MAX_QUERY = SEARCH_QUERY_MAX;
const DEFAULT_LIMIT = 10;
const toolDefinitions = [
  {
    name: "pageden_search",
    description: "Search readable documents in a Pageden workspace. Results include id and path — pass either to pageden_read_document to get the full body.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Optional when this token is bound to one workspace." },
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
        canonicalOnly: {
          type: "boolean",
          description: "Exclude superseded, draft, and archived documents so an agent reads only current sources of truth.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "pageden_list_documents",
    description: "List folders and documents visible to the current token/user.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
    },
  },
  {
    name: "pageden_read_document",
    description:
      "Read a document by id or path. Large documents are returned in chunks: use offset/maxChars and the truncated/nextOffset response fields to page through the full content.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
        offset: { type: "number", minimum: 0, description: "Character offset to start reading from. Default 0." },
        maxChars: {
          type: "number",
          minimum: 1,
          maximum: 200000,
          description: "Maximum characters of content to return. Default 50000.",
        },
        headingsOnly: {
          type: "boolean",
          description: "Return navigation metadata and headings without document content.",
        },
        latestChangedSection: {
          type: "boolean",
          description: "Also return the section that contains the latest changed line compared with the previous revision.",
        },
        canonicalOnly: {
          type: "boolean",
          description: "Fail if the requested document is draft, archived, or superseded.",
        },
      },
    },
  },
  {
    name: "pageden_recent_changes",
    description: "List recently updated readable documents. Each result includes id and path — pass either to pageden_read_document to get the full body.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } },
    },
  },
  {
    name: "pageden_answer_from_docs",
    description: "Gather cited Pageden context for answering a question from workspace documents.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        question: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["question"],
    },
  },
  {
    name: "pageden_find_related_docs",
    description: "Find readable documents related to a document or topic.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: "pageden_workspace_summary",
    description: "Summarize the visible workspace structure and recent activity for an agent.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 20 } },
    },
  },
  {
    name: "pageden_list_workspaces",
    description: "List all workspaces the current token/user can access. Use this to discover workspace IDs before calling workspace-scoped tools.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "pageden_lint_wikilinks",
    description: "Workspace-wide broken-wikilink inventory. Returns each broken link with the resolution attempts made (title / path / slug / fuzzy) and a suggested target the resolver thinks is closest. Use as the first call when an agent is asked to clean up a vault.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
    },
  },
  {
    name: "pageden_rewrite_wikilinks",
    description: "Workspace-wide find-and-replace on wikilink targets. Pass an array of {from,to} pairs; dryRun=true returns the proposed diff without writing. Cleanup writes go through applyDocumentWrite with allowNonCanonical=true so superseded docs can be touched.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        dryRun: { type: "boolean", description: "When true, return the per-doc occurrence counts without writing. Default true." },
        replacements: {
          type: "array",
          description: "Exact-match replacements applied to the text between [[…]] brackets.",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["replacements"],
    },
  },
  {
    name: "pageden_create_document",
    description:
      "Create a document in a folder where the token/user can edit. " +
      "Supply either path (e.g. 'pageden-dev/docs/my-doc') OR folderId + slug — not both. " +
      "When path is given, the slug is derived from the last segment and the folder is resolved by the preceding path.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        path: {
          type: "string",
          description: "Full document path such as 'folder/sub/my-doc' or 'folder/sub/my-doc.md'. Derives slug + folder automatically. Use instead of folderId + slug.",
        },
        folderId: { type: "string", description: "Target folder id. Required when path is not supplied." },
        title: { type: "string" },
        slug: {
          type: "string",
          description: "URL-safe slug (lowercase letters, numbers, hyphens). Required when path is not supplied.",
        },
        content: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "pageden_attach_file",
    description:
      "Upload a file and attach it to a document. Pass the bytes base64-encoded. Allowed types: PNG, JPEG, GIF, WebP, MP4, WebM, PDF, DOCX. " +
      "Max file size 50 MB; base64 encoding adds ~33% overhead so the actual payload sent to this tool may be up to ~67 MB. " +
      "For files over ~500 KB prefer pageden_request_attachment_upload (uploads raw bytes, no base64 inflation). " +
      "Requires the 'attachments' scope and editor access on the document.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Target document id." },
        filename: { type: "string", description: "Original file name, e.g. 'Password Policy.pdf'." },
        contentType: { type: "string", description: "MIME type, e.g. 'application/pdf'." },
        contentBase64: { type: "string", description: "Base64-encoded file bytes." },
      },
      required: ["documentId", "filename", "contentType", "contentBase64"],
    },
  },
  {
    name: "pageden_request_attachment_upload",
    description:
      "Get a short-lived URL to upload a large file as an attachment. Returns { uploadUrl, method: 'PUT', maxBytes, expiresInSeconds }. PUT the RAW file bytes to uploadUrl with the given Content-Type (no base64). Prefer this over pageden_attach_file for files over ~500 KB. Requires the 'attachments' scope and editor access.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Target document id." },
        filename: { type: "string", description: "Original file name, e.g. 'Access Management.pdf'." },
        contentType: { type: "string", description: "MIME type, e.g. 'application/pdf'." },
      },
      required: ["documentId", "filename", "contentType"],
    },
  },
  {
    name: "pageden_create_folder",
    description:
      "Create a folder. Root folders require workspace admin; child folders require editor access on the parent folder.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        parentFolderId: { type: ["string", "null"], description: "Omit or pass null to create a root folder." },
        name: { type: "string" },
        slug: { type: "string" },
      },
      required: ["name", "slug"],
    },
  },
  {
    name: "pageden_upsert_document_by_path",
    description: "Create or update a single Markdown document by workspace path, optionally creating missing folders.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        path: { type: "string", description: "Markdown path such as pageden-dev/docs/foo.md." },
        title: { type: "string" },
        content: { type: "string" },
        createFolders: { type: "boolean", description: "Create missing folders along the path." },
        baseVersion: { type: "string", description: "Optional conflict guard when updating an existing document." },
      },
      required: ["path", "title", "content"],
    },
  },
  {
    name: "pageden_import_markdown_tree",
    description: "Import a Markdown file tree from agent-provided file content. Supports dry_run, create_only, and upsert modes.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        rootPath: { type: "string", description: "Optional root folder path to prepend to every file path." },
        mode: { type: "string", enum: ["create_only", "upsert", "dry_run"] },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              title: { type: "string" },
              content: { type: "string" },
              checksum: { type: "string", description: "Optional sha256 checksum for the canonical Markdown content." },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["files"],
    },
  },
  {
    name: "pageden_update_document",
    description: "Replace a document's Markdown content using baseVersion conflict protection.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        baseVersion: { type: "string" },
        content: { type: "string" },
        title: { type: "string" },
      },
      required: ["documentId", "baseVersion", "content"],
    },
  },
  {
    name: "pageden_mark_document_canonical",
    description: "Promote a draft, superseded, or archived document to canonical without replacing the whole document body.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        path: { type: "string", description: "Alternative to documentId — resolves to a document by path within the workspace." },
        workspaceId: { type: "string", description: "Required when using path unless the agent token is workspace-bound." },
      },
    },
  },
  {
    name: "pageden_append_to_document",
    description: "Append Markdown to a document using the latest version.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        content: { type: "string" },
      },
      required: ["documentId", "content"],
    },
  },
  {
    name: "pageden_replace_section",
    description: "Replace the body of one section identified by heading anchor without round-tripping the full document. Heading stays put; pass the new section CONTENT only. Returns anchor_not_found with candidate anchors when the heading does not exist.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        path: { type: "string", description: "Alternative to documentId — resolves to a document by path within the workspace." },
        workspaceId: { type: "string" },
        anchor: { type: "string", description: "Heading anchor (e.g. 'acceptance-criteria') or human-readable heading text." },
        content: { type: "string", description: "New Markdown body for that section. Heading line is preserved by the server." },
        baseVersion: { type: "string", description: "DocumentRevision id the caller last saw; conflict-detected against the live version." },
        mode: { type: "string", enum: ["strict", "lenient"], description: "Reserved for future per-section drift detection. Today both behave the same as the global baseVersion check." },
      },
      required: ["anchor", "content", "baseVersion"],
    },
  },
  {
    name: "pageden_read_section",
    description: "Read a single section of a document by heading anchor or heading text. Use this to fetch one section without loading the whole document.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
        heading: {
          type: "string",
          description: "Heading anchor (e.g. \"acceptance-criteria\") or human-readable heading text.",
        },
      },
      required: ["heading"],
    },
  },
  {
    name: "pageden_get_task_packet",
    description: "Return a structured handoff packet (summary, acceptance criteria, next steps, open questions, implementation readiness) so an agent can start work without re-reading the whole document.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "pageden_list_decisions",
    description: "List structured `:::decision id status owner ... :::` blocks parsed from a document so agents can act on the final calls without re-reading prose.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "pageden_document_relationships",
    description: "Typed related-document panel for a single document: who supersedes whom, outbound wikilink/markdown references, inbound backlinks, and any PR links parsed from frontmatter. Use when an agent needs to know what touches a doc beyond semantic similarity.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "pageden_doc_stats",
    description: "Cheap shape-of-this-doc view (chars, tokenEstimate, chunkRecommendation, wikilinkCount, brokenWikilinkCount, decisionCount, openCommentCount, resolvedCommentCount) so an agent can choose a read strategy before committing tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string", description: "Alternative to documentId — resolves by path within the workspace." },
      },
    },
  },
  {
    name: "pageden_diff",
    description: "Unified diff between two revisions of the same document. Use for self-verification (did my last write do what I intended?) and review workflows. Both versions must belong to the same document.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string" },
        path: { type: "string", description: "Alternative to documentId — resolves by path within the workspace." },
        fromVersion: { type: "string", description: "Older DocumentRevision id." },
        toVersion: { type: "string", description: "Newer DocumentRevision id." },
      },
      required: ["fromVersion", "toVersion"],
    },
  },
  {
    name: "pageden_find_decisions",
    description: "Search structured `:::decision` blocks across every readable document in the workspace. Useful for finding a specific decision by id, status, owner, or free-text keywords without knowing which document holds it.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        query: { type: "string", description: "Free-text match against decision id, decision text, and reason." },
        status: { type: "string", description: "Filter by decision status (e.g. accepted, proposed, rejected)." },
        owner: { type: "string", description: "Filter by decision owner." },
        limit: { type: "number", minimum: 1, maximum: 100, description: "Max decisions to return; default 25." },
      },
    },
  },
  {
    name: "pageden_activity_timeline",
    description: "Recent document-related activity in a workspace (create/update/push/agent/restore). Each event has an `actor` field (user|agent|obsidian_plugin|system) so an agent can avoid duplicating work already done.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100 },
        before: {
          type: "string",
          description: "ISO timestamp; only events strictly older than this are returned. Use for paging.",
        },
      },
    },
  },
  {
    name: "pageden_add_section_comment",
    description: "Add a non-destructive inline review comment on a document, optionally anchored to a heading. Use for raising open questions or noting blockers without rewriting the doc prose. If this tool is unavailable or cancelled, report that the comment was not added instead of falling back to editing the document body.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string", description: "Alternative to documentId — resolves to a document by path within the workspace." },
        sectionAnchor: { type: "string", description: "Optional heading anchor (e.g. \"acceptance-criteria\") to scope the comment." },
        body: { type: "string", description: "The comment text." },
      },
      required: ["body"],
    },
  },
  {
    name: "pageden_list_comments",
    description: "List comments on a document. Returns open comments by default; pass includeResolved=true to see history.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
        includeResolved: { type: "boolean" },
      },
    },
  },
  {
    name: "pageden_resolve_comment",
    description: "Resolve a comment. Authors and managers can resolve; others get a forbidden error.",
    inputSchema: {
      type: "object",
      properties: { commentId: { type: "string" } },
      required: ["commentId"],
    },
  },
  {
    name: "pageden_my_unread",
    description: "List documents whose current version is newer than this caller's last-read bookmark for them. Useful as the first call in a session to focus on what changed.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "pageden_claim_document",
    description: "Soft-claim a document for the next ttlMinutes so other agents know you're working on it. Not a write lock — writes still serialize through baseVersion. Returns 409-style conflict if another actor holds an active claim.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
        ttlMinutes: { type: "number", minimum: 1, maximum: 240, description: "How long the claim should last; default 30, max 240." },
        note: { type: "string", description: "Optional short note explaining what you're doing." },
      },
    },
  },
  {
    name: "pageden_release_document",
    description: "Release your active claim on a document. Idempotent — returns ok even if no claim is held.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "pageden_list_claims",
    description: "List active document claims in a workspace so an agent can see who is working on what.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
    },
  },
  {
    name: "pageden_share_document",
    description: "Create a public share link for a document. Returns { slug, publicUrl, expiresAt }. Manager-only.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        path: { type: "string", description: "Alternative to documentId — resolves by path within the workspace." },
        ttlDays: { type: "number", minimum: 1, maximum: 365, description: "Days until the share expires; omit for no expiry." },
        password: { type: "string", description: "Optional share password; readers must pass ?password=… on the /s/:slug URL." },
        allowIndexing: { type: "boolean", description: "When true the share is crawler-friendly (x-robots-tag: all). Default false." },
      },
    },
  },
  {
    name: "pageden_revoke_share",
    description: "Revoke a share by id. Idempotent; returns the share row with revokedAt set. Author or manager.",
    inputSchema: {
      type: "object",
      properties: { shareId: { type: "string" } },
      required: ["shareId"],
    },
  },
  {
    name: "pageden_list_shares",
    description: "List active public shares in a workspace. Pass includeRevoked=true to see history.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string" },
        includeRevoked: { type: "boolean" },
      },
    },
  },
  {
    name: "pageden_delete_document",
    description:
      "Soft-delete a document. The document is hidden from all readers immediately; revisions are retained for recovery. Requires manager access on the document.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        documentId: { type: "string", description: "Document id to delete." },
        path: { type: "string", description: "Alternative to documentId — resolves by path within the workspace." },
      },
    },
  },
];

const readOnlyTool = (title: string): McpToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const writeTool = (title: string, options: { destructive?: boolean } = {}): McpToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: options.destructive ?? false,
  idempotentHint: false,
  openWorldHint: false,
});

const toolAnnotations: Record<string, McpToolAnnotations> = {
  pageden_list_workspaces: readOnlyTool("List workspaces"),
  pageden_search: readOnlyTool("Search documents"),
  pageden_list_documents: readOnlyTool("List documents"),
  pageden_read_document: readOnlyTool("Read document"),
  pageden_recent_changes: readOnlyTool("List recent changes"),
  pageden_answer_from_docs: readOnlyTool("Answer from documents"),
  pageden_find_related_docs: readOnlyTool("Find related documents"),
  pageden_workspace_summary: readOnlyTool("Summarize workspace"),
  pageden_lint_wikilinks: readOnlyTool("Lint wikilinks"),
  pageden_rewrite_wikilinks: writeTool("Rewrite wikilinks", { destructive: true }),
  pageden_create_document: writeTool("Create document"),
  pageden_attach_file: writeTool("Attach file to document"),
  pageden_request_attachment_upload: writeTool("Request attachment upload URL"),
  pageden_create_folder: writeTool("Create folder"),
  pageden_upsert_document_by_path: writeTool("Upsert document by path", { destructive: true }),
  pageden_import_markdown_tree: writeTool("Import Markdown tree", { destructive: true }),
  pageden_update_document: writeTool("Update document", { destructive: true }),
  pageden_mark_document_canonical: writeTool("Mark document canonical"),
  pageden_append_to_document: writeTool("Append to document"),
  pageden_replace_section: writeTool("Replace document section", { destructive: true }),
  pageden_read_section: readOnlyTool("Read document section"),
  pageden_get_task_packet: readOnlyTool("Get task packet"),
  pageden_list_decisions: readOnlyTool("List decisions"),
  pageden_document_relationships: readOnlyTool("Show document relationships"),
  pageden_doc_stats: readOnlyTool("Show document stats"),
  pageden_diff: readOnlyTool("Show document diff"),
  pageden_find_decisions: readOnlyTool("Find decisions"),
  pageden_activity_timeline: readOnlyTool("Show activity timeline"),
  pageden_add_section_comment: writeTool("Add section comment"),
  pageden_list_comments: readOnlyTool("List comments"),
  pageden_resolve_comment: writeTool("Resolve comment"),
  pageden_my_unread: readOnlyTool("List unread documents"),
  pageden_claim_document: writeTool("Claim document"),
  pageden_release_document: writeTool("Release document claim"),
  pageden_list_claims: readOnlyTool("List document claims"),
  pageden_share_document: writeTool("Share document"),
  pageden_revoke_share: writeTool("Revoke share", { destructive: true }),
  pageden_list_shares: readOnlyTool("List shares"),
  pageden_delete_document: writeTool("Delete document", { destructive: true }),
};

const tools = toolDefinitions.map((tool) => ({
  ...tool,
  annotations: (() => {
    const annotations = toolAnnotations[tool.name];
    if (!annotations) throw new Error(`Missing MCP tool annotations for ${tool.name}`);
    return annotations;
  })(),
}));

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/.well-known/pageden-mcp.json", async (request) => {
    const origin = requestOrigin(request);
    return {
      name: "Pageden",
      description: "Team Markdown knowledge base for web, Obsidian, and AI agents.",
      mcp: {
        endpoint: `${origin}/mcp`,
        transport: "streamable-http-json-rpc",
        authorization: "Bearer agent token",
        localBridge: {
          command: "npx",
          args: ["@pageden/mcp"],
          env: ["PAGEDEN_URL", "PAGEDEN_TOKEN", "PAGEDEN_WORKSPACE"],
        },
      },
      connect: {
        mode: "agent-token",
        setup: "Use Admin > AI Agents to create an agent token, then paste it into your MCP client config.",
      },
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    };
  });

  app.get("/llms.txt", async (_request, reply) => {
    reply.type("text/plain; charset=utf-8");
    return [
      "# Pageden",
      "",
      "Pageden is a shared Markdown knowledge base for teams and AI agents.",
      "",
      "Connect agents to the MCP endpoint:",
      "- Endpoint: /mcp",
      "- Auth: Authorization: Bearer <agent token>",
      "- Recommended token type: agent, workspace-bound, scoped to search/read/update as needed.",
      "",
      "Primary tools:",
      tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n"),
      "",
    ].join("\n");
  });

  app.get("/mcp", async (request, reply) => {
    const auth = await authenticate(request);
    if (auth) {
      return reply.send({
        ok: true,
        transport: "streamable-http",
        authType: auth.authType,
        tokenWorkspaceId: auth.tokenWorkspaceId ?? null,
      });
    }
    return mcpAuthenticationRequired(request, reply);
  });

  app.post("/mcp", async (request, reply) => {
    const auth = await requireAuth(request);
    const body = request.body;
    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((entry) => handleJsonRpc(entry, auth, request)));
      return responses.filter(Boolean);
    }
    const response = await handleJsonRpc(body, auth, request);
    if (!response) return reply.code(202).send();
    return response;
  });
}

function mcpAuthenticationRequired(_request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(401)
    .header("WWW-Authenticate", "Bearer")
    .send({
      error: "unauthorized",
      message: "Authentication required.",
    });
}

async function handleJsonRpc(
  body: unknown,
  auth: AuthContext,
  request: FastifyRequest,
): Promise<unknown | null> {
  const msg = body as JsonRpcRequest;
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return rpcError(null, -32600, "Invalid JSON-RPC request.");
  }
  const id = msg.id ?? null;
  if (msg.method.startsWith("notifications/")) return null;

  try {
    if (msg.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "pageden", version: "0.1.0" },
        instructions:
          "To read a document's full content use pageden_read_document (by path or id). " +
          "pageden_search and pageden_recent_changes return metadata and snippets only; always follow up with pageden_read_document to get the body. " +
          "For answering questions from the knowledge base, prefer pageden_answer_from_docs. " +
          "Documents are also available as MCP resources through resources/list and resources/read.",
      });
    }
    if (msg.method === "ping") return rpcResult(id, {});
    if (msg.method === "tools/list") return rpcResult(id, { tools });
    if (msg.method === "tools/call") {
      const params = asRecord(msg.params);
      const name = stringParam(params, "name");
      const args = asRecord(params.arguments ?? {});
      const result = await callTool(name, args, auth, request);
      return rpcResult(id, result);
    }
    if (msg.method === "resources/list") {
      const listed = await listDocumentsMcp(auth, {});
      const documents = "documents" in listed ? listed.documents : [];
      return rpcResult(id, {
        resources: documents.map((doc) => ({
          uri: `pageden://${(doc as { workspaceId?: string }).workspaceId ?? ""}/${doc.path}`,
          name: doc.title,
          mimeType: "text/markdown",
          description: doc.path,
        })),
      });
    }
    if (msg.method === "resources/read") {
      const params = asRecord(msg.params);
      const uri = stringParam(params, "uri");
      const parsed = parsePagedenUri(uri);
      const doc = await readDocument(auth, { workspaceId: parsed.workspaceId, path: parsed.path }, { auditRead: true, readMode: "resource" });
      return rpcResult(id, { contents: [{ uri, mimeType: "text/markdown", text: doc.content }] });
    }
    return rpcError(id, -32601, `Unsupported method: ${msg.method}`);
  } catch (error) {
    return rpcError(id, -32000, error instanceof Error ? error.message : "MCP tool failed.");
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  auth: AuthContext,
  request: FastifyRequest,
): Promise<{ content: McpContent[]; structuredContent?: unknown }> {
  let data: unknown;
  if (name === "pageden_search") data = await searchDocuments(auth, args, request);
  else if (name === "pageden_list_documents") data = await listDocumentsMcp(auth, args);
  else if (name === "pageden_read_document") data = await readDocumentChunked(auth, args);
  else if (name === "pageden_recent_changes") data = await recentChanges(auth, args, request);
  else if (name === "pageden_answer_from_docs") data = await answerFromDocs(auth, args, request);
  else if (name === "pageden_find_related_docs") data = await findRelatedDocs(auth, args, request);
  else if (name === "pageden_workspace_summary") data = await workspaceSummary(auth, args, request);
  else if (name === "pageden_list_workspaces") data = await listWorkspaces(auth);
  else if (name === "pageden_lint_wikilinks") data = await lintWikilinksByMcp(auth, args, request);
  else if (name === "pageden_rewrite_wikilinks") data = await rewriteWikilinksByMcp(auth, args, request);
  else if (name === "pageden_create_document") data = await createDocument(auth, args, request);
  else if (name === "pageden_attach_file") data = await attachFile(auth, args, request);
  else if (name === "pageden_request_attachment_upload") data = await requestAttachmentUpload(auth, args, request);
  else if (name === "pageden_create_folder") data = await createFolder(auth, args, request);
  else if (name === "pageden_upsert_document_by_path") data = await upsertDocumentByPath(auth, args, request);
  else if (name === "pageden_import_markdown_tree") data = await importMarkdownTree(auth, args, request);
  else if (name === "pageden_update_document") data = await updateDocument(auth, args, request);
  else if (name === "pageden_mark_document_canonical") data = await markDocumentCanonical(auth, args, request);
  else if (name === "pageden_append_to_document") data = await appendToDocument(auth, args, request);
  else if (name === "pageden_replace_section") data = await replaceSectionByMcp(auth, args, request);
  else if (name === "pageden_read_section") data = await readSection(auth, args);
  else if (name === "pageden_get_task_packet") data = await getTaskPacket(auth, args);
  else if (name === "pageden_list_decisions") data = await listDecisions(auth, args);
  else if (name === "pageden_document_relationships") data = await documentRelationshipsHandler(auth, args);
  else if (name === "pageden_doc_stats") data = await docStatsHandler(auth, args);
  else if (name === "pageden_diff") data = await docDiffHandler(auth, args);
  else if (name === "pageden_find_decisions") data = await findDecisions(auth, args, request);
  else if (name === "pageden_activity_timeline") data = await activityTimeline(auth, args, request);
  else if (name === "pageden_add_section_comment") data = await addSectionComment(auth, args, request);
  else if (name === "pageden_list_comments") data = await listSectionComments(auth, args, request);
  else if (name === "pageden_resolve_comment") data = await resolveSectionComment(auth, args);
  else if (name === "pageden_my_unread") data = await myUnread(auth, args, request);
  else if (name === "pageden_claim_document") data = await claimByMcp(auth, args, request);
  else if (name === "pageden_release_document") data = await releaseByMcp(auth, args, request);
  else if (name === "pageden_list_claims") data = await listClaimsByMcp(auth, args, request);
  else if (name === "pageden_share_document") data = await shareByMcp(auth, args, request);
  else if (name === "pageden_revoke_share") data = await revokeShareByMcp(auth, args);
  else if (name === "pageden_list_shares") data = await listSharesByMcp(auth, args, request);
  else if (name === "pageden_delete_document") data = await deleteDocument(auth, args);
  else throw new Error(`Unknown tool: ${name}`);

  const calledWorkspaceId =
    typeof data === "object" && data && "workspaceId" in data
      ? String((data as { workspaceId: unknown }).workspaceId)
      : undefined;
  // Note: we deliberately do NOT write an `mcp_tool_called` AuditEvent here. It
  // fired on every tool call (the single largest audit-volume source) and was
  // redundant with the specific per-action events (document_*_by_agent, etc.).
  // The call is still captured on the analytics bus below (agent_mcp_call).
  if (calledWorkspaceId) {
    trackServerEvent(
      "agent_mcp_call",
      calledWorkspaceId,
      { userId: auth.userId, tokenId: auth.tokenId ?? null },
      {
        tool_name: name,
        token_id: auth.tokenId ?? null,
        token_kind: auth.tokenKind,
        change_source: "agent",
      },
    );
  }

  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

async function resolveWorkspaceId(auth: AuthContext, requested: string | undefined, request: FastifyRequest): Promise<string> {
  const routeWorkspace = typeof request.query === "object" && request.query ? maybeString((request.query as Record<string, unknown>).workspaceId) : undefined;
  const target = requested ?? routeWorkspace ?? auth.tokenWorkspaceId ?? undefined;
  if (auth.tokenWorkspaceId && target && target !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
  if (target) return target;
  const memberships = await prisma.workspaceMembership.findMany({ where: { userId: auth.userId }, select: { workspaceId: true } });
  if (memberships.length === 1) return memberships[0]!.workspaceId;
  const workspaces = await prisma.workspace.findMany({ where: { id: { in: memberships.map((m) => m.workspaceId) } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const hint = workspaces.map((w) => `${w.id} (${w.name})`).join(", ");
  throw new Error(`workspaceId is required because this account can access multiple workspaces. Available: ${hint}`);
}

async function resolveWorkspaceIds(auth: AuthContext, requested: string | undefined): Promise<string[]> {
  if (auth.tokenWorkspaceId) {
    if (requested && requested !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
    return [auth.tokenWorkspaceId];
  }
  if (requested) return [requested];
  const memberships = await prisma.workspaceMembership.findMany({ where: { userId: auth.userId }, select: { workspaceId: true } });
  return memberships.map((m) => m.workspaceId);
}

async function listWorkspaces(auth: AuthContext) {
  requireTokenScope(auth, "read");
  const workspaceIds = await resolveWorkspaceIds(auth, undefined);
  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: workspaceIds } },
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });
  return { workspaces };
}

async function listDocumentsMcp(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "read");
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) return listDocuments(auth, workspaceIds[0]!);

  const settled = await Promise.allSettled(workspaceIds.map((wsId) => listDocuments(auth, wsId)));
  const folders: { id: string; parentFolderId: string | null; name: string; path: string; workspaceId: string }[] = [];
  const documents: { id: string; folderId: string | null; title: string; path: string; workspaceId: string; permission: unknown; version: string | null; checksum: string | null; status: string; updatedAt: string }[] = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    const wsId = workspaceIds[i]!;
    if (outcome.status === "fulfilled") {
      for (const f of outcome.value.folders) folders.push({ ...f, workspaceId: wsId });
      for (const d of outcome.value.documents) documents.push({ ...d, workspaceId: wsId });
    } else {
      errors.push({ workspaceId: wsId, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    }
  }
  return { folders, documents, errors };
}

async function listDocuments(auth: AuthContext, workspaceId: string) {
  requireTokenScope(auth, "read");
  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  const docs = await prisma.document.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { path: "asc" } });
  const visibleDocs = docs
    .map((doc) => ({ doc, role: resolver.documentRole(doc) }))
    .filter((entry) => entry.role !== null);
  const visibleFolderIds = new Set<string>();
  for (const folder of resolver.folders) {
    if (resolver.folderRole(folder.id)) visibleFolderIds.add(folder.id);
  }
  for (const { doc } of visibleDocs) {
    for (const id of resolver.ancestorFolderIds(doc.folderId)) visibleFolderIds.add(id);
  }
  return {
    workspaceId,
    folders: resolver.folders
      .filter((folder) => visibleFolderIds.has(folder.id))
      .map((folder) => ({ id: folder.id, parentFolderId: folder.parentFolderId, name: folder.name, path: folder.path })),
    documents: visibleDocs.map(({ doc, role }) => ({
      id: doc.id,
      folderId: doc.folderId,
      title: doc.title,
      path: doc.path,
      permission: role,
      version: doc.currentVersionId,
      checksum: doc.currentChecksum,
      status: doc.status,
      updatedAt: doc.updatedAt.toISOString(),
    })),
  };
}

async function searchDocuments(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "search");
  const query = stringParam(args, "query").trim().slice(0, MAX_QUERY);
  const limit = clampLimit(args.limit);
  const canonicalOnly = args.canonicalOnly === true || args.canonicalOnly === "true" || args.canonicalOnly === 1;

  const requestedWorkspaceId = maybeString(args.workspaceId);
  const workspaceIds = await resolveWorkspaceIds(auth, requestedWorkspaceId);

  if (workspaceIds.length === 1) {
    const workspaceId = workspaceIds[0]!;
    if (!query) return { workspaceId, results: [], errors: [] };
    const results = await runSearchDocuments({ userId: auth.userId, workspaceId, query, limit, canonicalOnly });
    return { workspaceId, results, errors: [] };
  }

  // Multi-workspace fan-out for unscoped tokens.
  if (!query) return { results: [], errors: [] };

  const workspaceNames = await prisma.workspace.findMany({
    where: { id: { in: workspaceIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(workspaceNames.map((w) => [w.id, w.name]));

  const settled = await Promise.allSettled(
    workspaceIds.map((wsId) => runSearchDocuments({ userId: auth.userId, workspaceId: wsId, query, limit, canonicalOnly })),
  );

  const results: Array<SearchDocumentsResult & { workspaceId: string; workspaceName: string }> = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    const wsId = workspaceIds[i]!;
    if (outcome.status === "fulfilled") {
      for (const r of outcome.value) {
        results.push({ ...r, workspaceId: wsId, workspaceName: nameById.get(wsId) ?? wsId });
      }
    } else {
      errors.push({ workspaceId: wsId, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    }
  }

  return { results: results.slice(0, limit), errors };
}

async function readDocument(auth: AuthContext, args: Record<string, unknown>, opts: { auditRead?: boolean; readMode?: string } = {}) {
  requireTokenScope(auth, "read");
  const documentId = maybeString(args.documentId);
  const path = maybeString(args.path);
  const workspaceId = maybeString(args.workspaceId) ?? auth.tokenWorkspaceId ?? undefined;
  if (!documentId && !path) throw new Error("documentId or path is required.");
  if (path && !workspaceId) throw new Error("workspaceId is required when reading by path.");
  const doc = await prisma.document.findFirst({
    where: documentId ? { id: documentId, deletedAt: null } : { workspaceId: workspaceId!, path: path!, deletedAt: null },
    include: { supersededBy: { select: { id: true, title: true, path: true, deletedAt: true } } },
  });
  if (!doc) throw new Error("Document not found.");
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
  const canonicalOnly = args.canonicalOnly === true || args.canonicalOnly === "true" || args.canonicalOnly === 1;
  if (canonicalOnly && doc.status !== "canonical") throw new Error("Document is not canonical.");
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) throw new Error("Document not found.");
  let content = "";
  if (doc.currentVersionId) {
    const revision = await prisma.documentRevision.findUnique({ where: { id: doc.currentVersionId }, select: { storageKey: true } });
    if (revision) content = await readContent(revision.storageKey);
  }
  const context = documentContext(content);
  const readiness = await aiReadinessForDocument({
    workspaceId: doc.workspaceId,
    documentId: doc.id,
    status: doc.status,
    title: doc.title,
    updatedAt: doc.updatedAt,
    context,
  });
  const supersededBy =
    doc.supersededBy && !doc.supersededBy.deletedAt
      ? { id: doc.supersededBy.id, title: doc.supersededBy.title, path: doc.supersededBy.path }
      : null;
  // Touch the caller's read cursor so pageden_my_unread can answer "what
  // changed since I last looked?" without scanning every revision. Failures
  // here must not break the read — log nothing and move on.
  await touchReadCursor(auth, { id: doc.id, workspaceId: doc.workspaceId, currentVersionId: doc.currentVersionId }).catch(() => undefined);
  if (opts.auditRead && auth.tokenKind === "agent") {
    // We no longer persist a `document_read_by_agent` AuditEvent — agent reads
    // are high-volume and the signal is fully captured on the analytics bus
    // (agent_document_read) below. Writes/changes remain in the audit trail.
    trackServerEvent(
      "agent_document_read",
      doc.workspaceId,
      { userId: auth.userId, tokenId: auth.tokenId ?? null },
      {
        doc_id: doc.id,
        token_id: auth.tokenId ?? null,
        read_mode: opts.readMode ?? "document",
        change_source: "agent",
      },
    );
  }
  return {
    workspaceId: doc.workspaceId,
    id: doc.id,
    folderId: doc.folderId,
    title: doc.title,
    path: doc.path,
    permission: role,
    version: doc.currentVersionId,
    checksum: doc.currentChecksum,
    status: doc.status,
    supersededBy,
    updatedAt: doc.updatedAt.toISOString(),
    content,
    body: context.body,
    frontmatter: context.frontmatter,
    headings: context.headings,
    wikilinks: context.wikilinks,
    aiReadiness: readiness,
    implementationReadiness: implementationReadinessFor({ status: doc.status, context }),
  };
}

const READ_CHUNK_DEFAULT = 50_000;
const READ_CHUNK_MAX = 200_000;

/**
 * MCP tool response for pageden_read_document: full read internally, but the returned
 * content is windowed by offset/maxChars so large documents are pageable by agents with
 * limited context. Internal callers (append/update) keep using readDocument directly.
 */
async function readDocumentChunked(auth: AuthContext, args: Record<string, unknown>) {
  const doc = await readDocument(auth, args, { auditRead: true, readMode: "document" });
  const headingsOnly = args.headingsOnly === true || args.headingsOnly === "true" || args.headingsOnly === 1;
  const latestChangedSection = args.latestChangedSection === true || args.latestChangedSection === "true" || args.latestChangedSection === 1;
  const latest = latestChangedSection ? await latestChangedSectionFor(doc.id, doc.content) : null;
  if (headingsOnly) {
    return {
      ...doc,
      content: "",
      body: undefined,
      totalChars: doc.content.length,
      offset: 0,
      returnedChars: 0,
      truncated: false,
      nextOffset: null,
      headingsOnly: true,
      latestChangedSection: latest,
    };
  }
  const rawOffset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
  const offset = Math.max(0, rawOffset);
  const rawMax = typeof args.maxChars === "number" && Number.isFinite(args.maxChars) ? Math.floor(args.maxChars) : READ_CHUNK_DEFAULT;
  const maxChars = Math.min(Math.max(1, rawMax), READ_CHUNK_MAX);
  const totalChars = doc.content.length;
  const chunk = doc.content.slice(offset, offset + maxChars);
  const truncated = offset > 0 || offset + chunk.length < totalChars;
  return {
    ...doc,
    content: chunk,
    // When truncated, body would duplicate oversized content; frontmatter/headings stay
    // available (computed from the full document) so agents can navigate.
    body: truncated ? undefined : doc.body,
    totalChars,
    offset,
    returnedChars: chunk.length,
    truncated,
    nextOffset: offset + chunk.length < totalChars ? offset + chunk.length : null,
    latestChangedSection: latest,
  };
}

async function latestChangedSectionFor(documentId: string, currentContent: string) {
  const current = await prisma.document.findUnique({
    where: { id: documentId },
    select: { currentVersionId: true },
  });
  if (!current?.currentVersionId) return null;
  const currentRevision = await prisma.documentRevision.findUnique({
    where: { id: current.currentVersionId },
    select: { versionNumber: true },
  });
  if (!currentRevision) return null;
  const previous = await prisma.documentRevision.findFirst({
    where: { documentId, versionNumber: { lt: currentRevision.versionNumber } },
    orderBy: { versionNumber: "desc" },
    select: { id: true, versionNumber: true, storageKey: true },
  });
  if (!previous) return null;
  const previousContent = await readContent(previous.storageKey);
  const changedLine = firstChangedLine(previousContent, currentContent);
  const section = sectionAtLine(currentContent, changedLine);
  return {
    previousRevisionId: previous.id,
    previousVersionNumber: previous.versionNumber,
    changedLine: changedLine + 1,
    section,
  };
}

function firstChangedLine(before: string, after: string): number {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const count = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < count; i += 1) {
    if ((beforeLines[i] ?? "") !== (afterLines[i] ?? "")) return i;
  }
  return 0;
}

function sectionAtLine(content: string, lineIndex: number) {
  const lines = content.split("\n");
  const headings = extractMarkdownHeadings(content, anchorForMcp);
  const current = headings.filter((heading) => heading.startLine <= lineIndex).at(-1) ?? headings[0] ?? null;
  if (!current) return null;
  const currentIndex = headings.indexOf(current);
  const endLine = headings[currentIndex + 1]?.startLine ?? lines.length;
  return {
    heading: current.heading,
    anchor: current.anchor,
    level: current.level,
    content: lines.slice(current.startLine + 1, endLine).join("\n").trim(),
  };
}

function anchorForMcp(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~[\]().,!?;:'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function readSection(auth: AuthContext, args: Record<string, unknown>) {
  const heading = stringParam(args, "heading");
  // Reuse the same auth/lookup logic as readDocument so permission checks and
  // workspace-binding behave identically; we then narrow the response to the
  // requested section so an agent loads one chunk instead of the whole doc.
  const doc = await readDocument(auth, {
    workspaceId: args.workspaceId,
    documentId: args.documentId,
    path: args.path,
    canonicalOnly: args.canonicalOnly,
  }, { auditRead: true, readMode: "section" });
  const sections = extractSections(doc.body ?? doc.content);
  const section = findSection(sections, heading);
  if (!section) {
    return {
      workspaceId: doc.workspaceId,
      id: doc.id,
      title: doc.title,
      path: doc.path,
      requested: heading,
      section: null,
      availableHeadings: sections.map(({ heading: title, anchor, level }) => ({ heading: title, anchor, level })),
    };
  }
  return {
    workspaceId: doc.workspaceId,
    id: doc.id,
    title: doc.title,
    path: doc.path,
    section,
  };
}

async function listDecisions(auth: AuthContext, args: Record<string, unknown>) {
  // Reuse the same read path so the prose source matches what an agent would see
  // calling pageden_read_document; we only narrow to the structured decisions list.
  const doc = await readDocument(auth, {
    workspaceId: args.workspaceId,
    documentId: args.documentId,
    path: args.path,
  });
  const decisions = extractDecisions(doc.body ?? doc.content);
  return {
    workspaceId: doc.workspaceId,
    id: doc.id,
    title: doc.title,
    path: doc.path,
    decisions,
  };
}

async function findDecisionsForWorkspace(
  auth: AuthContext,
  workspaceId: string,
  query: string,
  statusFilter: string,
  ownerFilter: string,
  limit: number,
) {
  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  const docs = await prisma.document.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, title: true, path: true, status: true, folderId: true, currentVersionId: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  const readable = docs.filter((doc) => resolver.documentRole(doc) !== null);

  // Cap how many docs we crack open: the parser is cheap, but each doc still
  // does one storage read. 200 docs is plenty for a "where was this decided?"
  // lookup and bounds the worst-case latency on huge workspaces.
  const DOC_SCAN_CAP = 200;
  const results: Array<{
    workspaceId: string;
    documentId: string;
    documentTitle: string;
    documentPath: string;
    documentStatus: string;
    documentUpdatedAt: string;
    decision: ReturnType<typeof extractDecisions>[number];
  }> = [];

  for (const doc of readable.slice(0, DOC_SCAN_CAP)) {
    if (!doc.currentVersionId) continue;
    const revision = await prisma.documentRevision.findUnique({ where: { id: doc.currentVersionId }, select: { storageKey: true } });
    if (!revision) continue;
    let content: string;
    try {
      content = await readContent(revision.storageKey);
    } catch {
      continue;
    }
    const context = documentContext(content);
    const decisions = extractDecisions(context.body);
    for (const decision of decisions) {
      if (statusFilter && (decision.status ?? "").toLowerCase() !== statusFilter) continue;
      if (ownerFilter && (decision.owner ?? "").toLowerCase() !== ownerFilter) continue;
      if (query) {
        const haystack = `${decision.id} ${decision.decision ?? ""} ${decision.reason ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      results.push({ workspaceId, documentId: doc.id, documentTitle: doc.title, documentPath: doc.path, documentStatus: doc.status, documentUpdatedAt: doc.updatedAt.toISOString(), decision });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }
  return { decisions: results, scannedDocuments: Math.min(readable.length, DOC_SCAN_CAP) };
}

async function findDecisions(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const query = (maybeString(args.query) ?? "").trim().toLowerCase();
  const statusFilter = (maybeString(args.status) ?? "").trim().toLowerCase();
  const ownerFilter = (maybeString(args.owner) ?? "").trim().toLowerCase();
  const limit = Math.min(clampLimit(args.limit) || 25, 100);
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) {
    const workspaceId = workspaceIds[0]!;
    const res = await findDecisionsForWorkspace(auth, workspaceId, query, statusFilter, ownerFilter, limit);
    return { workspaceId, decisions: res.decisions.map(({ workspaceId: _ws, ...d }) => d), scannedDocuments: res.scannedDocuments };
  }

  const settled = await Promise.allSettled(workspaceIds.map((wsId) => findDecisionsForWorkspace(auth, wsId, query, statusFilter, ownerFilter, limit)));
  const decisions: Awaited<ReturnType<typeof findDecisionsForWorkspace>>["decisions"] = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  let scannedDocuments = 0;
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") { decisions.push(...outcome.value.decisions); scannedDocuments += outcome.value.scannedDocuments; }
    else errors.push({ workspaceId: workspaceIds[i]!, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  }
  return { decisions: decisions.slice(0, limit), scannedDocuments, errors };
}

async function documentRelationshipsHandler(auth: AuthContext, args: Record<string, unknown>) {
  // Resolve the target the same way list_decisions / read_section do, so an
  // agent can pass either documentId or path.
  const doc = await readDocument(auth, {
    workspaceId: args.workspaceId,
    documentId: args.documentId,
    path: args.path,
  });
  const result = await documentRelationships(auth.userId, doc.id);
  if (!result) throw new Error("Document not found.");
  return result;
}

async function docStatsHandler(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "read");
  const doc = await readDocument(auth, {
    workspaceId: args.workspaceId,
    documentId: args.documentId,
    path: args.path,
  });
  const result = await documentStatsFor(doc.id);
  if (!result) throw new Error("Document not found.");
  return result;
}

async function docDiffHandler(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "read");
  const fromVersion = stringParam(args, "fromVersion");
  const toVersion = stringParam(args, "toVersion");
  // Allow either documentId or path; readDocument handles the resolution.
  const doc = await readDocument(auth, {
    workspaceId: args.workspaceId,
    documentId: args.documentId,
    path: args.path,
  });
  const result = await documentDiffFor(doc.id, fromVersion, toVersion);
  if ("error" in result) {
    throw new Error(
      result.error === "same_version"
        ? "fromVersion and toVersion must differ."
        : "Revision not found, or it belongs to another document.",
    );
  }
  return result;
}

async function activityTimeline(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const limit = Math.min(clampLimit(args.limit), 100);
  const before = typeof args.before === "string" && args.before ? new Date(args.before) : null;
  if (before && Number.isNaN(before.getTime())) throw new Error("before must be an ISO timestamp.");
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) return workspaceActivityFor(auth.userId, workspaceIds[0]!, { limit, before });

  const settled = await Promise.allSettled(workspaceIds.map((wsId) => workspaceActivityFor(auth.userId, wsId, { limit, before })));
  const events: unknown[] = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") {
      const payload = outcome.value as { events?: unknown[] };
      if (Array.isArray(payload.events)) events.push(...payload.events);
      else events.push(payload);
    } else {
      errors.push({ workspaceId: workspaceIds[i]!, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    }
  }
  return { events: events.slice(0, limit), errors };
}

// Resolve documentId from either documentId/path, with the same workspace
// binding rules as readDocument. Returns the doc id so the helpers stay
// permission-agnostic; permission gates live in the specific handler.
async function resolveDocumentIdForArg(auth: AuthContext, args: Record<string, unknown>): Promise<string> {
  const documentId = maybeString(args.documentId);
  if (documentId) return documentId;
  const path = maybeString(args.path);
  if (!path) throw new Error("documentId or path is required.");
  const workspaceId = maybeString(args.workspaceId) ?? auth.tokenWorkspaceId;
  if (!workspaceId) throw new Error("workspaceId is required when looking up by path.");
  const doc = await prisma.document.findFirst({ where: { workspaceId, path, deletedAt: null }, select: { id: true, workspaceId: true } });
  if (!doc) throw new Error("Document not found.");
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
  return doc.id;
}

async function addSectionComment(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "create");
  const documentId = await resolveDocumentIdForArg(auth, args);
  const body = stringParam(args, "body");
  const sectionAnchor = maybeString(args.sectionAnchor) ?? null;
  const result = await createComment(auth, documentId, { body, sectionAnchor });
  if (result.status === "not_found") throw new Error("Document not found.");
  if (result.status === "validation") throw new Error(result.message);
  return result.comment;
}

async function listSectionComments(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const documentId = await resolveDocumentIdForArg(auth, args);
  const includeResolved = args.includeResolved === true || args.includeResolved === "true";
  const result = await listComments(auth, documentId, { includeResolved });
  if (result.status === "not_found") throw new Error("Document not found.");
  return { documentId, comments: result.comments };
}

async function resolveSectionComment(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "update");
  const commentId = stringParam(args, "commentId");
  const result = await resolveCommentRecord(auth, commentId);
  if (result.status === "not_found") throw new Error("Comment not found.");
  if (result.status === "forbidden") throw new Error("You may not resolve this comment.");
  return result.comment;
}

async function myUnreadForWorkspace(auth: AuthContext, workspaceId: string, limit: number) {
  const docs = await unreadDocuments(auth, workspaceId);
  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  return docs
    .filter((doc) => resolver.documentRole({ id: doc.id, folderId: doc.folderId }) !== null)
    .slice(0, limit)
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      path: doc.path,
      workspaceId,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt.toISOString(),
      lastReadAt: doc.lastReadAt ? doc.lastReadAt.toISOString() : null,
      lastReadVersion: doc.lastReadVersion,
    }));
}

async function myUnread(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const limit = Math.min(clampLimit(args.limit), 100);
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) {
    const workspaceId = workspaceIds[0]!;
    const documents = await myUnreadForWorkspace(auth, workspaceId, limit);
    return { workspaceId, documents: documents.map(({ workspaceId: _ws, ...d }) => d) };
  }

  const settled = await Promise.allSettled(workspaceIds.map((wsId) => myUnreadForWorkspace(auth, wsId, limit)));
  const documents: Awaited<ReturnType<typeof myUnreadForWorkspace>> = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") documents.push(...outcome.value);
    else errors.push({ workspaceId: workspaceIds[i]!, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  }
  documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { documents: documents.slice(0, limit), errors };
}

async function claimByMcp(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "update");
  const documentId = await resolveDocumentIdForArg(auth, args);
  const ttl = typeof args.ttlMinutes === "number" ? args.ttlMinutes : undefined;
  const note = maybeString(args.note) ?? null;
  const result = await claimDocument(auth, documentId, { ttlMinutes: ttl, note });
  if (result.status === "not_found") throw new Error("Document not found.");
  if (result.status === "conflict") throw new Error(`Already claimed by ${result.existing.actorLabel ?? "another actor"} until ${result.existing.expiresAt}.`);
  return result.claim;
}

async function releaseByMcp(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "update");
  const documentId = await resolveDocumentIdForArg(auth, args);
  const result = await releaseClaim(auth, documentId);
  if (result.status === "not_found") throw new Error("Document not found.");
  return { claim: result.claim };
}

async function listClaimsByMcp(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) {
    const workspaceId = workspaceIds[0]!;
    return { workspaceId, claims: await listActiveClaims(workspaceId) };
  }

  const settled = await Promise.allSettled(workspaceIds.map((wsId) => listActiveClaims(wsId).then((claims) => ({ workspaceId: wsId, claims }))));
  const claims: { workspaceId: string; claims: Awaited<ReturnType<typeof listActiveClaims>> }[] = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") claims.push(outcome.value);
    else errors.push({ workspaceId: workspaceIds[i]!, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  }
  return { claims, errors };
}

async function shareByMcp(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "update");
  const documentId = await resolveDocumentIdForArg(auth, args);
  const ttlDays = typeof args.ttlDays === "number" ? args.ttlDays : undefined;
  const password = maybeString(args.password) ?? null;
  const allowIndexing = args.allowIndexing === true;
  const result = await createShare(auth, documentId, { ttlDays, password, allowIndexing });
  if (result.status === "not_found") throw new Error("Document not found.");
  if (result.status === "forbidden") throw new Error("Only managers can create shares.");
  if (result.status === "validation") throw new Error(result.message);
  return result.share;
}

async function revokeShareByMcp(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "update");
  const shareId = stringParam(args, "shareId");
  const result = await revokeShare(auth, shareId);
  if (result.status === "not_found") throw new Error("Share not found.");
  if (result.status === "forbidden") throw new Error("You may not revoke this share.");
  return result.share;
}

async function listSharesByMcp(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const documentId = maybeString(args.documentId);
  const includeRevoked = args.includeRevoked === true || args.includeRevoked === "true";
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) {
    const workspaceId = workspaceIds[0]!;
    const result = await listShares(auth, workspaceId, { documentId, includeRevoked });
    if (result.status === "not_found") throw new Error("Workspace not found.");
    return { workspaceId, shares: result.shares };
  }

  const settled = await Promise.allSettled(
    workspaceIds.map(async (wsId) => {
      const result = await listShares(auth, wsId, { documentId, includeRevoked });
      if (result.status === "not_found") throw new Error("Workspace not found.");
      return { workspaceId: wsId, shares: result.shares };
    }),
  );
  const workspaceShares: { workspaceId: string; shares: unknown[] }[] = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") workspaceShares.push(outcome.value);
    else errors.push({ workspaceId: workspaceIds[i]!, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  }
  return { workspaces: workspaceShares, errors };
}

async function getTaskPacket(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "read");
  const documentId = maybeString(args.documentId);
  const path = maybeString(args.path);
  if (!documentId && !path) throw new Error("documentId or path is required.");
  let resolvedId = documentId;
  if (!resolvedId) {
    const workspaceId = maybeString(args.workspaceId) ?? auth.tokenWorkspaceId;
    if (!workspaceId) throw new Error("workspaceId is required when looking up by path.");
    const doc = await prisma.document.findFirst({
      where: { workspaceId, path: path!, deletedAt: null },
      select: { id: true, workspaceId: true },
    });
    if (!doc) throw new Error("Document not found.");
    if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) {
      throw new Error("This agent token is bound to another workspace.");
    }
    resolvedId = doc.id;
  }
  const result = await buildHandoffPacket(auth.userId, resolvedId);
  if (result.status === "not_found") throw new Error("Document not found.");
  return result.value;
}


async function recentChangesForWorkspace(auth: AuthContext, workspaceId: string, limit: number) {
  const resolver = await buildWorkspaceResolver(auth.userId, workspaceId);
  const docs = await prisma.document.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 100 });
  return docs
    .map((doc) => ({ doc, role: resolver.documentRole(doc) }))
    .filter((entry) => entry.role !== null)
    .slice(0, limit)
    .map(({ doc, role }) => ({
      id: doc.id,
      title: doc.title,
      path: doc.path,
      workspaceId,
      permission: role,
      version: doc.currentVersionId,
      status: doc.status,
      updatedAt: doc.updatedAt.toISOString(),
    }));
}

async function recentChanges(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const limit = clampLimit(args.limit);
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) {
    const workspaceId = workspaceIds[0]!;
    const documents = await recentChangesForWorkspace(auth, workspaceId, limit);
    return { workspaceId, documents: documents.map(({ workspaceId: _ws, ...d }) => d) };
  }

  const settled = await Promise.allSettled(workspaceIds.map((wsId) => recentChangesForWorkspace(auth, wsId, limit)));
  const documents: Awaited<ReturnType<typeof recentChangesForWorkspace>> = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") documents.push(...outcome.value);
    else errors.push({ workspaceId: workspaceIds[i]!, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  }
  documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { documents: documents.slice(0, limit), errors };
}

async function answerFromDocs(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "search");
  requireTokenScope(auth, "read");
  const question = stringParam(args, "question").trim().slice(0, MAX_QUERY);
  const limit = Math.min(clampLimit(args.limit), 20);
  const search = await searchDocuments(auth, { workspaceId: maybeString(args.workspaceId), query: question, limit }, request);
  const citations = [];
  for (const result of search.results.slice(0, limit)) {
    const doc = await readDocument(auth, { documentId: result.id });
    citations.push({
      id: doc.id,
      title: doc.title,
      path: doc.path,
      workspaceId: doc.workspaceId,
      updatedAt: doc.updatedAt,
      headings: doc.headings,
      frontmatter: doc.frontmatter,
      snippet: result.snippet ?? excerpt(doc.content, question),
      excerpt: excerpt(doc.content, question),
    });
  }
  return {
    question,
    instruction: "Answer the user using only these citations. If the citations are not enough, say what is missing.",
    citations,
  };
}

async function findRelatedDocs(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "search");
  requireTokenScope(auth, "read");
  const limit = Math.min(clampLimit(args.limit), 20);
  const explicitQuery = maybeString(args.query);
  let seedQuery = explicitQuery;
  let source: { id: string; title: string; path: string; workspaceId: string } | null = null;
  if (!seedQuery && (maybeString(args.documentId) || maybeString(args.path))) {
    const doc = await readDocument(auth, { workspaceId: maybeString(args.workspaceId), documentId: maybeString(args.documentId), path: maybeString(args.path) });
    source = { id: doc.id, title: doc.title, path: doc.path, workspaceId: doc.workspaceId };
    seedQuery = keywords(`${doc.title}\n${doc.content}`).slice(0, 8).join(" ");
  }
  if (!seedQuery) throw new Error("query, documentId, or path is required.");
  const search = await searchDocuments(auth, { workspaceId: maybeString(args.workspaceId), query: seedQuery, limit: limit + 1 }, request);
  return {
    source,
    query: seedQuery,
    related: search.results.filter((doc) => doc.id !== source?.id).slice(0, limit),
  };
}

async function lintWikilinksByMcp(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const broken = await lintWikilinks(workspaceId, auth.userId);
  return {
    workspaceId,
    brokenCount: broken.length,
    broken: broken.map((entry) => ({
      ...entry,
      explanation: brokenLinkExplanation(entry),
    })),
  };
}

async function rewriteWikilinksByMcp(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "update");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const rawReplacements = Array.isArray(args.replacements) ? args.replacements : null;
  if (!rawReplacements || rawReplacements.length === 0) {
    throw new Error("At least one replacement is required.");
  }
  const replacements: RewriteReplacement[] = [];
  for (const item of rawReplacements) {
    if (!item || typeof item !== "object") throw new Error("Each replacement must be an object with from/to fields.");
    const from = (item as { from?: unknown }).from;
    const to = (item as { to?: unknown }).to;
    if (typeof from !== "string" || typeof to !== "string" || !from.trim()) {
      throw new Error("Each replacement must have non-empty from and to strings.");
    }
    replacements.push({ from, to });
  }
  // Default to dryRun=true so an unguarded call cannot accidentally write.
  const dryRun = args.dryRun === undefined ? true : args.dryRun === true || args.dryRun === "true";
  return rewriteWikilinks(workspaceId, replacements, dryRun, auth);
}

async function workspaceSummaryForOne(auth: AuthContext, workspaceId: string, limit: number) {
  const listed = await listDocuments(auth, workspaceId);
  const recent = await recentChangesForWorkspace(auth, workspaceId, limit);
  const topFolders = listed.folders
    .map((folder) => ({
      ...folder,
      documentCount: listed.documents.filter((doc) => doc.path.startsWith(`${folder.path}/`)).length,
    }))
    .sort((a, b) => b.documentCount - a.documentCount || a.path.localeCompare(b.path))
    .slice(0, limit);
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, agentEditScopeFolderId: true, agentEditScopeFolder: { select: { path: true } } },
  });
  const agentEditScope = workspace?.agentEditScopeFolderId
    ? { folderId: workspace.agentEditScopeFolderId, folderPath: workspace.agentEditScopeFolder?.path ?? null }
    : null;
  return {
    workspaceId,
    workspaceName: workspace?.name ?? workspaceId,
    totals: { folders: listed.folders.length, documents: listed.documents.length },
    topFolders,
    recentDocuments: recent.map(({ workspaceId: _ws, ...d }) => d),
    agentEditScope,
  };
}

async function workspaceSummary(auth: AuthContext, args: Record<string, unknown>, _request: FastifyRequest) {
  requireTokenScope(auth, "read");
  const limit = Math.min(clampLimit(args.limit), 20);
  const workspaceIds = await resolveWorkspaceIds(auth, maybeString(args.workspaceId));

  if (workspaceIds.length === 1) return workspaceSummaryForOne(auth, workspaceIds[0]!, limit);

  const settled = await Promise.allSettled(workspaceIds.map((wsId) => workspaceSummaryForOne(auth, wsId, limit)));
  const workspaces: Awaited<ReturnType<typeof workspaceSummaryForOne>>[] = [];
  const errors: { workspaceId: string; reason: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") workspaces.push(outcome.value);
    else errors.push({ workspaceId: workspaceIds[i]!, reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  }
  return { workspaces, errors };
}

async function requestAttachmentUpload(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "attachments");
  const documentId = stringParam(args, "documentId");
  const filename = stringParam(args, "filename");
  const contentType = stringParam(args, "contentType").split(";")[0]?.trim() || "";
  const role = await resolveDocumentRole(auth.userId, documentId);
  if (role === null) throw new Error("Document not found.");
  if (!atLeast(role, "editor")) throw new Error("Editor access is required to attach files.");
  if (!ATTACHMENT_ALLOWED_MIME.has(contentType)) throw new Error(`Content type "${contentType}" is not allowed.`);
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { workspaceId: true } });
  const grant = signUploadGrant({
    workspaceId: doc.workspaceId,
    documentId,
    userId: auth.userId,
    filename,
    contentType,
    maxBytes: MAX_ATTACHMENT_BYTES,
  });
  const host = requestHost(request);
  let scheme: string;
  try {
    scheme = new URL(env.webOrigin).protocol;
  } catch {
    scheme = "https:";
  }
  const uploadUrl = `${scheme}//${host}/api/attachments/upload?grant=${encodeURIComponent(grant)}`;
  return {
    workspaceId: doc.workspaceId,
    uploadUrl,
    method: "PUT" as const,
    maxBytes: MAX_ATTACHMENT_BYTES,
    expiresInSeconds: UPLOAD_GRANT_TTL_SECONDS,
    headers: { "content-type": contentType },
    instructions:
      "PUT the raw file bytes to uploadUrl with the given Content-Type within expiresInSeconds. The response is the attachment metadata.",
  };
}

async function attachFile(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "attachments");
  const documentId = stringParam(args, "documentId");
  const filename = stringParam(args, "filename");
  const contentType = stringParam(args, "contentType");
  const contentBase64 = stringParam(args, "contentBase64").replace(/\s+/g, "");
  if (!contentBase64) throw new Error("contentBase64 is required.");
  const body = Buffer.from(contentBase64, "base64");
  if (body.length === 0) throw new Error("contentBase64 did not decode to any content.");
  const userAgent = request.headers["user-agent"];
  const { attachment, workspaceId } = await createDocumentAttachment({
    documentId,
    userId: auth.userId,
    filename,
    contentType,
    body,
    ip: request.ip,
    userAgent: typeof userAgent === "string" ? userAgent : undefined,
  });
  return { ...attachment, documentId, workspaceId };
}

async function createDocument(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "create");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const title = stringParam(args, "title").trim();
  const content = maybeString(args.content) ?? "";
  if (!title) throw new Error("title is required.");

  let resolvedFolderId: string;
  let resolvedSlug: string;
  const docPath = maybeString(args.path);
  if (docPath) {
    const normalized = docPath.replace(/^\//, "").replace(/\.md$/i, "").trim();
    if (!normalized) throw new Error("path is invalid.");
    const lastSlash = normalized.lastIndexOf("/");
    resolvedSlug = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
    const folderPath = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
    if (!isValidSlug(resolvedSlug)) throw new Error("The last path segment must be a valid slug (lowercase letters, numbers, hyphens).");
    const folderRecord = await prisma.folder.findFirst({ where: { path: folderPath, workspaceId, deletedAt: null }, select: { id: true } });
    if (!folderRecord) throw new Error(`Folder not found at path: ${folderPath || "(root)"}`);
    resolvedFolderId = folderRecord.id;
  } else {
    const rawFolderId = maybeString(args.folderId);
    const rawSlug = maybeString(args.slug)?.trim().toLowerCase() ?? "";
    if (!rawFolderId) throw new Error("Either path or folderId is required.");
    if (!rawSlug || !isValidSlug(rawSlug)) throw new Error("slug must be lowercase letters, numbers, and hyphens.");
    resolvedFolderId = rawFolderId;
    resolvedSlug = rawSlug;
  }

  const folder = await prisma.folder.findFirst({ where: { id: resolvedFolderId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!folder) throw new Error("Folder not found.");
  const folderRole = await resolveFolderRole(auth.userId, folder.id);
  if (folderRole === null) throw new Error("Folder not found.");
  if (!atLeast(folderRole, "editor")) throw new Error("Forbidden.");

  const sum = computeChecksum(content);
  const { storageKey } = await writeContent(content, workspaceId);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockFolderTree(tx, workspaceId);
      const lockedFolder = await tx.folder.findFirst({ where: { id: folder.id, workspaceId, deletedAt: null }, select: { path: true } });
      if (!lockedFolder) throw new Error("Folder not found.");
      const path = buildDocumentPath(lockedFolder.path, resolvedSlug);
      const existing = await tx.document.findFirst({ where: { folderId: resolvedFolderId, slug: resolvedSlug, deletedAt: null }, select: { id: true } });
      if (existing) throw new Error("A document with this slug already exists in the folder.");
      const doc = await tx.document.create({
        data: { workspaceId, folderId: resolvedFolderId, title, slug: resolvedSlug, path, createdById: auth.userId, updatedById: auth.userId },
      });
      const revision = await tx.documentRevision.create({
        data: { documentId: doc.id, versionNumber: 1, storageKey, checksum: sum, createdById: auth.userId, changeSource: "agent", contributorIds: [auth.userId] },
      });
      const metadata = await metadataFromContent(tx, workspaceId, content, doc.id);
      const updated = await tx.document.update({
        where: { id: doc.id },
        data: {
          currentVersionId: revision.id,
          currentChecksum: sum,
          searchText: searchTextFor(content),
          status: metadata.status,
          supersededById: metadata.supersededById,
        },
      });
      await writeAuditEvent(
        {
          workspaceId,
          userId: auth.userId,
          action: "document_created_by_agent",
          targetType: "document",
          targetId: doc.id,
          metadata: { path, version: revision.id, tokenId: auth.tokenId, tokenName: auth.tokenName },
        },
        tx,
      );
      trackServerEvent(
        "agent_document_created",
        workspaceId,
        { userId: auth.userId, tokenId: auth.tokenId ?? null },
        {
          doc_id: doc.id,
          token_id: auth.tokenId ?? null,
          change_source: "agent",
        },
      );
      return { workspaceId, id: doc.id, title, path: updated.path, version: revision.id, checksum: sum, updatedAt: updated.updatedAt.toISOString() };
    });
    return result;
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A document with this slug or path already exists.", { cause: error });
    throw error;
  }
}

function documentContentWithStatus(content: string, status: "canonical" | "draft" | "superseded" | "archived"): string {
  const statusLine = `status: ${status}`;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return `---\n${statusLine}\n---\n\n${content}`;

  const rawFrontmatter = match[1] ?? "";
  const body = content.slice(match[0].length);
  const lines = rawFrontmatter.split(/\r?\n/);
  const kept: string[] = [];
  let skippingKey: string | null = null;

  for (const line of lines) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1]!.toLowerCase();
      skippingKey = key === "status" || key === "supersededby" ? key : null;
      if (key === "status" || key === "supersededby") continue;
    } else if (skippingKey && /^\s*-\s+/.test(line)) {
      continue;
    } else {
      skippingKey = null;
    }
    kept.push(line);
  }

  const cleaned = kept.filter((line, index, arr) => line.trim() || arr[index - 1]?.trim() || arr[index + 1]?.trim());
  cleaned.unshift(statusLine);
  return `---\n${cleaned.join("\n").trim()}\n---\n\n${body.replace(/^\s+/, "")}`;
}

async function markDocumentCanonical(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "update");
  let documentId = maybeString(args.documentId);
  if (!documentId) {
    const path = stringParam(args, "path");
    const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
    const doc = await prisma.document.findFirst({
      where: { workspaceId, path, deletedAt: null },
      select: { id: true },
    });
    if (!doc) throw new Error("Document not found.");
    documentId = doc.id;
  }
  await assertTokenOwnsDocument(auth, documentId);

  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true, currentVersionId: true, currentChecksum: true, updatedAt: true, status: true, supersededById: true },
  });
  if (!doc) throw new Error("Document not found.");
  if (doc.status === "canonical" && doc.supersededById === null) {
    return {
      workspaceId: doc.workspaceId,
      ok: true,
      documentId: doc.id,
      version: doc.currentVersionId ?? "",
      checksum: doc.currentChecksum ?? "",
      updatedAt: doc.updatedAt.toISOString(),
      noOp: true,
    };
  }

  let content = "";
  if (doc.currentVersionId) {
    const revision = await prisma.documentRevision.findUnique({
      where: { id: doc.currentVersionId },
      select: { storageKey: true },
    });
    if (revision) content = await readContent(revision.storageKey);
  }

  const outcome = await applyDocumentWrite({
    documentId: doc.id,
    auth,
    baseVersion: doc.currentVersionId ?? "",
    content: documentContentWithStatus(content, "canonical"),
    changeSource: "agent",
    allowNonCanonical: true,
  });
  if (!outcome.ok) {
    throw new Error(
      outcome.status === "conflict"
        ? `Conflict. Current version is ${outcome.currentVersion}.`
        : outcome.status ?? "Mark canonical failed.",
    );
  }
  await writeAuditEvent({
    workspaceId: doc.workspaceId,
    userId: auth.userId,
    action: "document_updated_by_agent",
    targetType: "document",
    targetId: doc.id,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { tokenId: auth.tokenId, tokenName: auth.tokenName, version: outcome.version, operation: "mark_canonical" },
  });
  if (!outcome.noOp) {
    trackServerEvent(
      "agent_document_saved",
      doc.workspaceId,
      { userId: auth.userId, tokenId: auth.tokenId ?? null },
      {
        doc_id: doc.id,
        token_id: auth.tokenId ?? null,
        change_source: "agent",
        operation: "mark_canonical",
      },
    );
  }
  return { workspaceId: doc.workspaceId, ...outcome, noOp: outcome.noOp ?? false, updatedAt: outcome.updatedAt?.toISOString() };
}

async function deleteDocument(auth: AuthContext, args: Record<string, unknown>) {
  requireTokenScope(auth, "update");
  const documentId = maybeString(args.documentId);
  const path = maybeString(args.path);
  const workspaceId = maybeString(args.workspaceId) ?? auth.tokenWorkspaceId ?? undefined;
  if (!documentId && !path) throw new Error("documentId or path is required.");
  if (path && !workspaceId) throw new Error("workspaceId is required when deleting by path.");
  const doc = await prisma.document.findFirst({
    where: documentId ? { id: documentId, deletedAt: null } : { workspaceId: workspaceId!, path: path!, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!doc) throw new Error("Document not found.");
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) throw new Error("Document not found.");
  if (!atLeast(role, "manager")) throw new Error("Forbidden. Deleting a document requires manager access.");
  const deletedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await lockFolderTree(tx, doc.workspaceId);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Document" WHERE "id" = ${doc.id} AND "deletedAt" IS NULL FOR UPDATE`;
    if (locked.length === 0) throw new Error("Document not found.");
    await tx.document.update({ where: { id: doc.id }, data: { deletedAt } });
    await tx.permission.deleteMany({ where: { workspaceId: doc.workspaceId, resourceType: "document", resourceId: doc.id } });
    await writeAuditEvent(
      { workspaceId: doc.workspaceId, userId: auth.userId, action: "document_deleted", targetType: "document", targetId: doc.id },
      tx,
    );
  });
  return { workspaceId: doc.workspaceId, ok: true, deletedAt: deletedAt.toISOString() };
}

async function createFolder(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "create");
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const parentFolderId = maybeString(args.parentFolderId) ?? null;
  const name = stringParam(args, "name").trim();
  const slug = stringParam(args, "slug").trim().toLowerCase();
  if (!name) throw new Error("name is required.");
  if (!slug || !isValidSlug(slug)) throw new Error("slug must be lowercase letters, numbers, and hyphens.");

  if (parentFolderId) {
    const parent = await prisma.folder.findFirst({
      where: { id: parentFolderId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) throw new Error("Parent folder not found.");
    const parentRole = await resolveFolderRole(auth.userId, parent.id);
    if (parentRole === null) throw new Error("Parent folder not found.");
    if (!atLeast(parentRole, "editor")) throw new Error("Forbidden.");
  } else if (!(await canManageWorkspace(auth.userId, workspaceId))) {
    throw new Error("Only workspace admins can create root folders.");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await lockFolderTree(tx, workspaceId);
      let parentPath: string | null = null;
      if (parentFolderId) {
        const parent = await tx.folder.findFirst({
          where: { id: parentFolderId, workspaceId, deletedAt: null },
          select: { path: true },
        });
        if (!parent) throw new Error("Parent folder not found.");
        const az = await authorizeFolderRole(auth, parentFolderId, "editor", tx);
        if (!az.ok) throw new Error(az.status === "not_found" ? "Parent folder not found." : "Forbidden.");
        parentPath = parent.path;
      } else if (!(await canManageWorkspace(auth.userId, workspaceId, tx))) {
        throw new Error("Only workspace admins can create root folders.");
      }

      if (await siblingFolderSlugTaken(tx, workspaceId, parentFolderId, slug)) {
        throw new Error("A folder with this slug already exists here.");
      }
      const path = buildFolderPath(parentPath, slug);
      const folder = await tx.folder.create({
        data: {
          workspaceId,
          parentFolderId,
          name,
          slug,
          path,
          createdById: auth.userId,
          updatedById: auth.userId,
        },
      });
      await writeAuditEvent(
        {
          workspaceId,
          userId: auth.userId,
          action: "folder_created_by_agent",
          targetType: "folder",
          targetId: folder.id,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
          metadata: { path, tokenId: auth.tokenId, tokenName: auth.tokenName },
        },
        tx,
      );
      return {
        workspaceId,
        id: folder.id,
        parentFolderId: folder.parentFolderId,
        name: folder.name,
        slug: folder.slug,
        path: folder.path,
        updatedAt: folder.updatedAt.toISOString(),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A folder with this slug or path already exists.", { cause: error });
    throw error;
  }
}

async function siblingFolderSlugTaken(
  tx: Tx,
  workspaceId: string,
  parentFolderId: string | null,
  slug: string,
): Promise<boolean> {
  const existing = await tx.folder.findFirst({
    where: { workspaceId, parentFolderId, slug, deletedAt: null },
    select: { id: true },
  });
  return existing !== null;
}

type UpsertMode = "create_only" | "upsert" | "dry_run";

type ParsedMarkdownPath = {
  folderSegments: Array<{ name: string; slug: string }>;
  documentTitle: string;
  documentSlug: string;
  documentPath: string;
};

async function upsertDocumentByPath(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const parsed = parseMarkdownPath(stringParam(args, "path"), maybeString(args.title));
  const content = stringParamAllowEmpty(args, "content");
  const createFolders = args.createFolders === true;
  const baseVersion = maybeString(args.baseVersion);
  return upsertDocumentAtPath({
    auth,
    workspaceId,
    parsed,
    content,
    createFolders,
    mode: "upsert",
    baseVersion,
    request,
  });
}

async function importMarkdownTree(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  const workspaceId = await resolveWorkspaceId(auth, maybeString(args.workspaceId), request);
  const mode = parseImportMode(maybeString(args.mode));
  const rootPath = maybeString(args.rootPath);
  const files = parseImportFiles(args.files);
  const report = {
    workspaceId,
    mode,
    createdFolders: [] as string[],
    createdDocuments: [] as string[],
    updatedDocuments: [] as string[],
    skippedDocuments: [] as string[],
    failedItems: [] as Array<{ path: string; message: string }>,
    warnings: [] as string[],
  };
  const createdFolderPaths = new Set<string>();

  for (const file of files) {
    const targetPath = rootPath ? `${trimTrailingSlashes(rootPath)}/${file.path}` : file.path;
    try {
      const computedChecksum = computeChecksum(file.content);
      if (file.checksum && file.checksum !== computedChecksum) throw new Error("checksum does not match content.");
      const parsed = parseMarkdownPath(targetPath, file.title);
      for (const folderPath of predictedFolderPaths(parsed)) {
        const existing = await prisma.folder.findFirst({ where: { workspaceId, path: folderPath, deletedAt: null }, select: { id: true } });
        if (!existing && !createdFolderPaths.has(folderPath)) {
          report.createdFolders.push(folderPath);
          createdFolderPaths.add(folderPath);
        }
      }
      const result = await upsertDocumentAtPath({
        auth,
        workspaceId,
        parsed,
        content: file.content,
        createFolders: true,
        mode,
        request,
      });
      if (result.action === "created") report.createdDocuments.push(result.path);
      else if (result.action === "updated") report.updatedDocuments.push(result.path);
      else report.skippedDocuments.push(result.path);
      for (const folder of result.createdFolders) {
        if (!createdFolderPaths.has(folder.path)) {
          report.createdFolders.push(folder.path);
          createdFolderPaths.add(folder.path);
        }
      }
    } catch (error) {
      report.failedItems.push({ path: file.path, message: error instanceof Error ? error.message : "Import failed." });
    }
  }

  return {
    ...report,
    totals: {
      files: files.length,
      createdFolders: report.createdFolders.length,
      createdDocuments: report.createdDocuments.length,
      updatedDocuments: report.updatedDocuments.length,
      skippedDocuments: report.skippedDocuments.length,
      failedItems: report.failedItems.length,
      warnings: report.warnings.length,
    },
  };
}

async function upsertDocumentAtPath({
  auth,
  workspaceId,
  parsed,
  content,
  createFolders,
  mode,
  baseVersion,
  request,
}: {
  auth: AuthContext;
  workspaceId: string;
  parsed: ParsedMarkdownPath;
  content: string;
  createFolders: boolean;
  mode: UpsertMode;
  baseVersion?: string;
  request: FastifyRequest;
}) {
  const existing = await prisma.document.findFirst({
    where: { workspaceId, path: parsed.documentPath, deletedAt: null },
    select: { id: true, title: true, path: true, currentVersionId: true, currentChecksum: true },
  });
  const sum = computeChecksum(content);

  if (existing) {
    if (mode === "create_only") {
      requireTokenScope(auth, "create");
      return documentUpsertResult("skipped", workspaceId, existing.id, existing.title, existing.path, existing.currentVersionId, existing.currentChecksum, [], "Document already exists.");
    }
    requireTokenScope(auth, "update");
    await assertTokenOwnsDocument(auth, existing.id);
    const role = await resolveDocumentRole(auth.userId, existing.id);
    if (role === null) throw new Error("Document not found.");
    if (!atLeast(role, "editor")) throw new Error("Forbidden.");
    if (mode === "dry_run") {
      const action = existing.currentChecksum === sum && existing.title === parsed.documentTitle ? "skipped" : "updated";
      return documentUpsertResult(action, workspaceId, existing.id, parsed.documentTitle, existing.path, existing.currentVersionId, existing.currentChecksum, [], action === "skipped" ? "Document is unchanged." : "Document would be updated.");
    }
    if (existing.currentChecksum === sum && existing.title === parsed.documentTitle) {
      return documentUpsertResult("skipped", workspaceId, existing.id, existing.title, existing.path, existing.currentVersionId, existing.currentChecksum, [], "Document is unchanged.");
    }
    const guardVersion = baseVersion ?? existing.currentVersionId ?? "";
    const outcome = await applyDocumentWrite({
      documentId: existing.id,
      auth,
      baseVersion: guardVersion,
      content,
      title: parsed.documentTitle,
      changeSource: "agent",
    });
    if (!outcome.ok) throw new Error(outcome.status === "conflict" ? `Conflict. Current version is ${outcome.currentVersion}.` : outcome.status ?? "Write failed.");
    await writeAuditEvent({
      workspaceId,
      userId: auth.userId,
      action: "document_upserted_by_agent",
      targetType: "document",
      targetId: existing.id,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      metadata: { path: parsed.documentPath, tokenId: auth.tokenId, tokenName: auth.tokenName, version: outcome.version },
    });
    return {
      action: "updated",
      workspaceId,
      id: existing.id,
      title: parsed.documentTitle,
      path: existing.path,
      version: outcome.version,
      checksum: outcome.checksum,
      updatedAt: outcome.updatedAt?.toISOString(),
      createdFolders: [],
    };
  }

  requireTokenScope(auth, "create");
  if (mode === "dry_run") {
    const missingFolders = await missingFolderPaths(workspaceId, parsed);
    return {
      action: "created",
      workspaceId,
      id: null,
      title: parsed.documentTitle,
      path: parsed.documentPath,
      version: null,
      checksum: sum,
      updatedAt: null,
      createdFolders: missingFolders.map((path) => ({ path })),
      message: "Document would be created.",
    };
  }

  if (!createFolders) {
    const folderPath = parsed.folderSegments.map((segment) => segment.slug).join("/");
    const folder = await prisma.folder.findFirst({ where: { workspaceId, path: folderPath, deletedAt: null }, select: { id: true } });
    if (!folder) throw new Error("Folder not found. Pass createFolders=true to create missing folders.");
  }

  const { storageKey } = await writeContent(content, workspaceId);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockFolderTree(tx, workspaceId);
      const { folder, createdFolders } = await ensureFolderPath(tx, auth, workspaceId, parsed.folderSegments, createFolders);
      const role = await resolveFolderRole(auth.userId, folder.id, tx);
      if (role === null) throw new Error("Folder not found.");
      if (!atLeast(role, "editor")) throw new Error("Forbidden.");
      const scope = await enforceAgentEditScope(auth, workspaceId, folder.id, tx);
      if (!scope.ok) throw new Error("Forbidden.");
      const duplicate = await tx.document.findFirst({
        where: { workspaceId, folderId: folder.id, slug: parsed.documentSlug, deletedAt: null },
        select: { id: true },
      });
      if (duplicate) throw new Error("A document with this path already exists.");
      const doc = await tx.document.create({
        data: {
          workspaceId,
          folderId: folder.id,
          title: stripNul(parsed.documentTitle),
          slug: parsed.documentSlug,
          path: parsed.documentPath,
          createdById: auth.userId,
          updatedById: auth.userId,
        },
      });
      const revision = await tx.documentRevision.create({
        data: { documentId: doc.id, versionNumber: 1, storageKey, checksum: sum, createdById: auth.userId, changeSource: "agent", contributorIds: [auth.userId] },
      });
      const updated = await tx.document.update({
        where: { id: doc.id },
        data: { currentVersionId: revision.id, currentChecksum: sum, searchText: searchTextFor(content) },
      });
      await writeAuditEvent(
        {
          workspaceId,
          userId: auth.userId,
          action: "document_created_by_agent",
          targetType: "document",
          targetId: doc.id,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
          metadata: { path: parsed.documentPath, tokenId: auth.tokenId, tokenName: auth.tokenName, version: revision.id, via: "path_upsert" },
        },
        tx,
      );
      trackServerEvent(
        "agent_document_created",
        workspaceId,
        { userId: auth.userId, tokenId: auth.tokenId ?? null },
        {
          doc_id: doc.id,
          token_id: auth.tokenId ?? null,
          via: "path_upsert",
          change_source: "agent",
        },
      );
      return {
        action: "created",
        workspaceId,
        id: doc.id,
        title: doc.title,
        path: updated.path,
        version: revision.id,
        checksum: sum,
        updatedAt: updated.updatedAt.toISOString(),
        createdFolders,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A document or folder with this path already exists.", { cause: error });
    throw error;
  }
}

async function ensureFolderPath(
  tx: Tx,
  auth: AuthContext,
  workspaceId: string,
  segments: ParsedMarkdownPath["folderSegments"],
  createFolders: boolean,
) {
  const userId = auth.userId;
  if (segments.length === 0) throw new Error("Documents must be inside a folder path.");
  let parent: { id: string; path: string } | null = null;
  const createdFolders: Array<{ id: string; path: string }> = [];

  for (const segment of segments) {
    const parentId: string | null = parent ? parent.id : null;
    const parentPath: string | null = parent ? parent.path : null;
    const existing: { id: string; path: string } | null = await tx.folder.findFirst({
      where: { workspaceId, parentFolderId: parentId, slug: segment.slug, deletedAt: null },
      select: { id: true, path: true },
    });
    if (existing) {
      parent = existing;
      continue;
    }
    if (!createFolders) throw new Error("Folder not found. Pass createFolders=true to create missing folders.");
    if (parent) {
      const az = await authorizeFolderRole(auth, parent.id, "editor", tx);
      if (!az.ok) throw new Error(az.status === "not_found" ? "Parent folder not found." : "Forbidden.");
    } else if (!(await canManageWorkspace(userId, workspaceId, tx))) {
      throw new Error("Only workspace admins can create root folders.");
    }
    if (await siblingFolderSlugTaken(tx, workspaceId, parent?.id ?? null, segment.slug)) {
      throw new Error("A folder with this slug already exists here.");
    }
    const path = buildFolderPath(parentPath, segment.slug);
    const folder: { id: string; path: string } = await tx.folder.create({
      data: {
        workspaceId,
        parentFolderId: parentId,
        name: stripNul(segment.name),
        slug: segment.slug,
        path,
        createdById: userId,
        updatedById: userId,
      },
      select: { id: true, path: true },
    });
    await writeAuditEvent(
      { workspaceId, userId, action: "folder_created_by_agent", targetType: "folder", targetId: folder.id, metadata: { path, via: "path_upsert" } },
      tx,
    );
    createdFolders.push(folder);
    parent = folder;
  }

  if (!parent) throw new Error("Documents must be inside a folder path.");
  return { folder: parent, createdFolders };
}

async function missingFolderPaths(workspaceId: string, parsed: ParsedMarkdownPath): Promise<string[]> {
  const paths = predictedFolderPaths(parsed);
  if (!paths.length) return [];
  const existing = await prisma.folder.findMany({ where: { workspaceId, path: { in: paths }, deletedAt: null }, select: { path: true } });
  const existingPaths = new Set(existing.map((folder) => folder.path));
  return paths.filter((path) => !existingPaths.has(path));
}

function predictedFolderPaths(parsed: ParsedMarkdownPath): string[] {
  const paths: string[] = [];
  let current = "";
  for (const segment of parsed.folderSegments) {
    current = current ? `${current}/${segment.slug}` : segment.slug;
    paths.push(current);
  }
  return paths;
}

function documentUpsertResult(
  action: "created" | "updated" | "skipped",
  workspaceId: string,
  id: string,
  title: string,
  path: string,
  version: string | null,
  checksum: string | null,
  createdFolders: Array<{ id?: string; path: string }>,
  message: string,
) {
  return { action, workspaceId, id, title, path, version, checksum, createdFolders, message };
}

function parseMarkdownPath(path: string, title?: string): ParsedMarkdownPath {
  const originalPath = normalizeImportPath(path.trim()).replace(/^\/+/, "");
  if (!originalPath || isUnsafeRelativePath(originalPath)) throw new Error("path must be a safe relative Markdown path.");
  const parts = originalPath.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("path must include at least one folder and a Markdown filename.");
  const filename = parts.at(-1)!;
  if (!filename.toLowerCase().endsWith(".md")) throw new Error("path must end with .md.");
  const folderSegments = parts.slice(0, -1).map((name) => ({ name, slug: slugifyImportPath(name) }));
  const documentSlug = slugifyImportPath(filename);
  if (!documentSlug || !isValidSlug(documentSlug)) throw new Error("path filename cannot produce a valid slug.");
  const documentTitle = stripNul((title ?? filename.replace(/\.md$/i, "")).trim() || "Untitled");
  const folderPath = folderSegments.map((segment) => segment.slug).join("/");
  return {
    folderSegments,
    documentTitle,
    documentSlug,
    documentPath: buildDocumentPath(folderPath, documentSlug),
  };
}

function parseImportMode(value: string | undefined): UpsertMode {
  if (!value) return "upsert";
  if (value === "create_only" || value === "upsert" || value === "dry_run") return value;
  throw new Error("mode must be create_only, upsert, or dry_run.");
}

function parseImportFiles(value: unknown): Array<{ path: string; title?: string; content: string; checksum?: string }> {
  if (!Array.isArray(value)) throw new Error("files is required.");
  if (value.length > 200) throw new Error("files is limited to 200 items per MCP call.");
  return value.map((item, index) => {
    const record = asRecord(item);
    const path = maybeString(record.path);
    const content = typeof record.content === "string" ? record.content : undefined;
    if (!path) throw new Error(`files[${index}].path is required.`);
    if (content === undefined) throw new Error(`files[${index}].content is required.`);
    return { path, title: maybeString(record.title), content, checksum: maybeString(record.checksum) };
  });
}

function normalizeImportPath(path: string): string {
  const normalized = path.split("\\").join("/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts[0] === ".") parts.shift();
  return parts.join("/");
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function isUnsafeRelativePath(path: string): boolean {
  const normalized = normalizeImportPath(path);
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return true;
  const parts = normalized.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "..") depth -= 1;
    else if (part && part !== ".") depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

function slugifyImportPath(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function stripNul(value: string): string {
  // eslint-disable-next-line no-control-regex -- Postgres text/jsonb reject NUL bytes.
  return value.replace(/\u0000/g, "");
}

async function updateDocument(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "update");
  const documentId = stringParam(args, "documentId");
  const baseVersion = stringParam(args, "baseVersion");
  const content = stringParam(args, "content");
  const title = maybeString(args.title)?.trim();
  await assertTokenOwnsDocument(auth, documentId);
  const outcome = await applyDocumentWrite({ documentId, auth, baseVersion, content, title, changeSource: "agent" });
  if (!outcome.ok) throw new Error(outcome.status === "conflict" ? `Conflict. Current version is ${outcome.currentVersion}.` : outcome.status ?? "Write failed.");
  const updateWorkspaceId = await workspaceIdForDocument(documentId);
  await writeAuditEvent({
    workspaceId: updateWorkspaceId,
    userId: auth.userId,
    action: "document_updated_by_agent",
    targetType: "document",
    targetId: documentId,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { tokenId: auth.tokenId, tokenName: auth.tokenName, version: outcome.version },
  });
  if (!outcome.noOp) {
    trackServerEvent(
      "agent_document_saved",
      updateWorkspaceId,
      { userId: auth.userId, tokenId: auth.tokenId ?? null },
      {
        doc_id: documentId,
        token_id: auth.tokenId ?? null,
        change_source: "agent",
      },
    );
  }
  return { workspaceId: updateWorkspaceId, ...outcome, updatedAt: outcome.updatedAt?.toISOString() };
}

async function appendToDocument(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "append");
  const current = await readDocument(auth, { documentId: stringParam(args, "documentId") });
  const addition = stringParam(args, "content");
  const base = current.content.endsWith("\n") || current.content.length === 0 ? current.content : `${current.content}\n`;
  await assertTokenOwnsDocument(auth, current.id);
  const outcome = await applyDocumentWrite({
    documentId: current.id,
    auth,
    baseVersion: current.version ?? "",
    content: `${base}${addition}`,
    changeSource: "agent",
  });
  if (!outcome.ok) throw new Error(outcome.status === "conflict" ? `Conflict. Current version is ${outcome.currentVersion}.` : outcome.status ?? "Append failed.");
  const workspaceId = await workspaceIdForDocument(current.id);
  await writeAuditEvent({
    workspaceId,
    userId: auth.userId,
    action: "document_appended_by_agent",
    targetType: "document",
    targetId: current.id,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { tokenId: auth.tokenId, tokenName: auth.tokenName, version: outcome.version },
  });
  return { workspaceId, ...outcome, updatedAt: outcome.updatedAt?.toISOString() };
}

async function replaceSectionByMcp(auth: AuthContext, args: Record<string, unknown>, request: FastifyRequest) {
  requireTokenScope(auth, "update");
  const anchor = stringParam(args, "anchor");
  const newContent = stringParam(args, "content");
  const baseVersion = stringParam(args, "baseVersion");
  const current = await readDocument(auth, {
    workspaceId: args.workspaceId,
    documentId: args.documentId,
    path: args.path,
  });
  await assertTokenOwnsDocument(auth, current.id);
  const spliced = replaceSection(current.content, anchor, newContent);
  if (!spliced) {
    const error: Error & { code?: string; data?: unknown } = new Error("anchor_not_found");
    error.code = "anchor_not_found";
    error.data = { anchor, suggested: suggestAnchors(current.content, anchor) };
    throw error;
  }
  const outcome = await applyDocumentWrite({
    documentId: current.id,
    auth,
    baseVersion,
    content: spliced.body,
    changeSource: "agent",
  });
  if (!outcome.ok) {
    throw new Error(
      outcome.status === "conflict"
        ? `Conflict. Current version is ${outcome.currentVersion}.`
        : outcome.status ?? "Replace failed.",
    );
  }
  const workspaceId = await workspaceIdForDocument(current.id);
  await writeAuditEvent({
    workspaceId,
    userId: auth.userId,
    action: "document_section_replaced_by_agent",
    targetType: "document",
    targetId: current.id,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"],
    metadata: { tokenId: auth.tokenId, tokenName: auth.tokenName, version: outcome.version, anchor: spliced.anchor },
  });
  return {
    workspaceId,
    documentId: outcome.documentId,
    version: outcome.version,
    checksum: outcome.checksum,
    updatedAt: outcome.updatedAt?.toISOString(),
    latestChangedSection: { anchor: spliced.anchor },
  };
}

async function assertTokenOwnsDocument(auth: AuthContext, documentId: string): Promise<void> {
  if (!auth.tokenWorkspaceId) return;
  const workspaceId = await workspaceIdForDocument(documentId);
  if (workspaceId !== auth.tokenWorkspaceId) throw new Error("This agent token is bound to another workspace.");
}

async function workspaceIdForDocument(documentId: string): Promise<string> {
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, select: { workspaceId: true } });
  if (!doc) throw new Error("Document not found.");
  return doc.workspaceId;
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = maybeString(params[key]);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function stringParamAllowEmpty(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`${key} is required.`);
  return value;
}

function clampLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? DEFAULT_LIMIT);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 50) : DEFAULT_LIMIT;
}

function excerpt(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const idx = compact.toLowerCase().indexOf(query.toLowerCase());
  const start = idx === -1 ? 0 : Math.max(0, idx - 220);
  const end = idx === -1 ? 420 : Math.min(compact.length, idx + query.length + 220);
  return `${start > 0 ? "... " : ""}${compact.slice(start, end)}${end < compact.length ? " ..." : ""}`;
}

function keywords(content: string): string[] {
  const stop = new Set(["about", "after", "again", "also", "because", "before", "could", "document", "from", "have", "into", "markdown", "pageden", "should", "that", "their", "there", "these", "this", "with", "would"]);
  const counts = new Map<string, number>();
  for (const word of content.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word]) => word);
}

function parsePagedenUri(uri: string): { workspaceId: string; path: string } {
  const parsed = new URL(uri);
  if (parsed.protocol !== "pageden:") throw new Error("Unsupported resource URI.");
  return { workspaceId: parsed.hostname, path: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) };
}

function requestOrigin(request: FastifyRequest): string {
  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string" ? request.headers["x-forwarded-proto"].split(",")[0]?.trim() : null;
  const proto = forwardedProto || request.protocol;
  const host = requestHost(request) || request.hostname;
  return `${proto}://${host}`;
}
