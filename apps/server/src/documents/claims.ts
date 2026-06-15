import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope, type AuthContext } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, resolveDocumentRole } from "../permissions/index.js";

// A claim is a soft "I'm working on this doc" signal — NOT a write lock.
// Writes still go through applyDocumentWrite's row-locked transaction. The
// dashboard surfaces active claims so concurrent agents can coordinate
// ("Codex is already working on this plan"). expiresAt is mandatory so a
// crashed agent's claim auto-frees rather than blocking the doc forever.

const DEFAULT_TTL_MIN = 30;
const MAX_TTL_MIN = 4 * 60;
const MAX_NOTE = 400;
const MAX_LABEL = 80;

function ttlExpiry(minutes: number | undefined): Date {
  const m = typeof minutes === "number" && Number.isFinite(minutes) ? Math.floor(minutes) : DEFAULT_TTL_MIN;
  const clamped = Math.min(Math.max(m, 1), MAX_TTL_MIN);
  return new Date(Date.now() + clamped * 60 * 1000);
}

function actorLabelFor(auth: AuthContext): string | null {
  if (auth.tokenName) return `${auth.tokenName} (${auth.tokenKind ?? "agent"})`;
  return null;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

interface ClaimRow {
  id: string;
  workspaceId: string;
  documentId: string;
  tokenId: string | null;
  userId: string | null;
  actorLabel: string | null;
  note: string | null;
  expiresAt: Date;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toClaimDto(row: ClaimRow) {
  const active = !row.releasedAt && row.expiresAt.getTime() > Date.now();
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    tokenId: row.tokenId,
    userId: row.userId,
    actorLabel: row.actorLabel,
    note: row.note,
    expiresAt: row.expiresAt.toISOString(),
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function ownsClaim(auth: AuthContext, claim: ClaimRow): boolean {
  if (auth.tokenId && claim.tokenId === auth.tokenId) return true;
  if (!auth.tokenId && claim.userId === auth.userId) return true;
  return false;
}

export async function claimDocument(
  auth: AuthContext,
  documentId: string,
  opts: { ttlMinutes?: number; note?: string | null },
): Promise<{ status: "ok"; claim: ReturnType<typeof toClaimDto> } | { status: "not_found" } | { status: "conflict"; existing: ReturnType<typeof toClaimDto> }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };
  if (!atLeast(role, "editor")) {
    // Viewers can't claim — claims signal "I plan to edit this," which makes
    // no sense if you have no write permission.
    return { status: "not_found" };
  }

  const expiresAt = ttlExpiry(opts.ttlMinutes);
  const note = clip(opts.note ?? null, MAX_NOTE);

  // Free any expired or released claim by the same actor on the same doc so
  // re-claim is a no-op refresh, not a unique-constraint surprise.
  const now = new Date();
  const existing = await prisma.documentClaim.findFirst({
    where: {
      documentId: doc.id,
      releasedAt: null,
      expiresAt: { gt: now },
      NOT: {
        OR: [
          ...(auth.tokenId ? [{ tokenId: auth.tokenId }] : []),
          ...(auth.tokenId ? [] : [{ userId: auth.userId }]),
        ],
      },
    },
  });
  if (existing) return { status: "conflict", existing: toClaimDto(existing) };

  // Refresh own claim if one already exists; otherwise create a new row.
  const mine = await prisma.documentClaim.findFirst({
    where: {
      documentId: doc.id,
      ...(auth.tokenId ? { tokenId: auth.tokenId } : { userId: auth.userId, tokenId: null }),
      releasedAt: null,
    },
  });
  const actorLabel = clip(actorLabelFor(auth), MAX_LABEL);
  const row = mine
    ? await prisma.documentClaim.update({
        where: { id: mine.id },
        data: { expiresAt, note: note ?? mine.note, actorLabel: actorLabel ?? mine.actorLabel },
      })
    : await prisma.documentClaim.create({
        data: {
          workspaceId: doc.workspaceId,
          documentId: doc.id,
          tokenId: auth.tokenId ?? null,
          userId: auth.tokenId ? null : auth.userId,
          actorLabel,
          note,
          expiresAt,
        },
      });
  await writeAuditEvent({
    workspaceId: doc.workspaceId,
    userId: auth.userId,
    action: auth.tokenKind === "agent" ? "document_claimed_by_agent" : "document_claimed",
    targetType: "document_claim",
    targetId: row.id,
    metadata: { documentId: doc.id, tokenId: auth.tokenId, expiresAt: expiresAt.toISOString() },
  });
  return { status: "ok", claim: toClaimDto(row) };
}

export async function releaseClaim(
  auth: AuthContext,
  documentId: string,
): Promise<{ status: "ok"; claim: ReturnType<typeof toClaimDto> | null } | { status: "not_found" }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { id: true, workspaceId: true },
  });
  if (!doc) return { status: "not_found" };
  if (auth.tokenWorkspaceId && doc.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, doc.id);
  if (!role) return { status: "not_found" };

  const mine = await prisma.documentClaim.findFirst({
    where: {
      documentId: doc.id,
      ...(auth.tokenId ? { tokenId: auth.tokenId } : { userId: auth.userId, tokenId: null }),
      releasedAt: null,
    },
  });
  if (!mine) return { status: "ok", claim: null };
  const released = await prisma.documentClaim.update({
    where: { id: mine.id },
    data: { releasedAt: new Date() },
  });
  await writeAuditEvent({
    workspaceId: doc.workspaceId,
    userId: auth.userId,
    action: "document_claim_released",
    targetType: "document_claim",
    targetId: mine.id,
    metadata: { documentId: doc.id, tokenId: auth.tokenId },
  });
  return { status: "ok", claim: toClaimDto(released) };
}

export async function adminReleaseClaim(
  auth: AuthContext,
  claimId: string,
): Promise<{ status: "ok" } | { status: "not_found" } | { status: "forbidden" }> {
  const claim = await prisma.documentClaim.findUnique({ where: { id: claimId } });
  if (!claim) return { status: "not_found" };
  if (auth.tokenWorkspaceId && claim.workspaceId !== auth.tokenWorkspaceId) return { status: "not_found" };
  const role = await resolveDocumentRole(auth.userId, claim.documentId);
  if (!role) return { status: "not_found" };
  if (!ownsClaim(auth, claim) && !atLeast(role, "manager")) return { status: "forbidden" };
  if (!claim.releasedAt) {
    await prisma.documentClaim.update({ where: { id: claim.id }, data: { releasedAt: new Date() } });
    await writeAuditEvent({
      workspaceId: claim.workspaceId,
      userId: auth.userId,
      action: "document_claim_released",
      targetType: "document_claim",
      targetId: claim.id,
      metadata: { documentId: claim.documentId, releasedBy: auth.userId, override: !ownsClaim(auth, claim) },
    });
  }
  return { status: "ok" };
}

export async function listActiveClaims(workspaceId: string) {
  const now = new Date();
  const rows = await prisma.documentClaim.findMany({
    where: { workspaceId, releasedAt: null, expiresAt: { gt: now } },
    orderBy: { expiresAt: "asc" },
    include: { document: { select: { id: true, title: true, path: true, deletedAt: true } } },
  });
  return rows
    .filter((row) => !row.document.deletedAt)
    .map((row) => ({
      ...toClaimDto(row),
      document: { id: row.document.id, title: row.document.title, path: row.document.path },
    }));
}

export async function registerClaimRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { ttlMinutes?: number; note?: string | null } }>(
    "/api/documents/:id/claim",
    { config: { rateLimit: { max: Number(process.env.CLAIMS_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const ttl = typeof request.body?.ttlMinutes === "number" ? request.body.ttlMinutes : undefined;
      if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
        return validationError(reply, { ttlMinutes: "ttlMinutes must be a positive number of minutes." });
      }
      const result = await claimDocument(auth, request.params.id, { ttlMinutes: ttl, note: request.body?.note ?? null });
      if (result.status === "not_found") return notFound(reply, "Document not found.");
      if (result.status === "conflict") return reply.code(409).send({ error: "conflict", claim: result.existing });
      return reply.code(201).send({ claim: result.claim });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/documents/:id/release",
    { config: { rateLimit: { max: Number(process.env.CLAIMS_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const result = await releaseClaim(auth, request.params.id);
      if (result.status === "not_found") return notFound(reply, "Document not found.");
      return { claim: result.claim };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/claims/:id",
    { config: { rateLimit: { max: Number(process.env.CLAIMS_WRITE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "update");
      const result = await adminReleaseClaim(auth, request.params.id);
      if (result.status === "not_found") return notFound(reply, "Claim not found.");
      if (result.status === "forbidden") return forbidden(reply);
      return { ok: true };
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/claims",
    { config: { rateLimit: { max: Number(process.env.CLAIMS_READ_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      requireTokenScope(auth, "read");
      const workspaceId = request.params.workspaceId;
      const membership = await prisma.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: auth.userId } },
        select: { workspaceId: true },
      });
      if (!membership) return notFound(reply, "Workspace not found.");
      const claims = await listActiveClaims(workspaceId);
      return { workspaceId, claims };
    },
  );
}
