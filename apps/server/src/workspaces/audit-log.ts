import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { canManageWorkspace } from "../permissions/index.js";
import { notFound, validationError } from "../errors.js";

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
export const AUDIT_EXPORT_CAP = 10_000;

// Read CLOUD_HOSTED at request time so tests can toggle it (mirrors logo.ts).
function cloudHostedEnabled(): boolean {
  const v = process.env.CLOUD_HOSTED;
  if (v === undefined) return env.cloudHosted;
  return v === "true" || v === "1";
}

function defaultRetentionDays(): number {
  const n = Number(process.env.AUDIT_DEFAULT_RETENTION_DAYS ?? 365);
  return Number.isFinite(n) ? n : 365;
}

// Operator guardrail: an optional hard ceiling that overrides per-workspace
// settings (including "keep forever"). 0/unset = no cap.
function maxRetentionDays(): number {
  const raw = process.env.AUDIT_MAX_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const SENSITIVE_KEY = /token|secret|password|hash|authorization|cookie|apikey|api_key|\bkey\b/i;

/**
 * Redact audit metadata before it leaves the server: drop sensitive-looking keys
 * and cap string lengths. Returns a plain object (or null) — never the raw row.
 */
export function redactAuditMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = v.length > 500 ? `${v.slice(0, 500)}…` : v;
    } else if (v === null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      // Nested objects/arrays: keep a compact JSON string, capped.
      const s = JSON.stringify(v);
      out[k] = s.length > 500 ? `${s.slice(0, 500)}…` : s;
    }
  }
  return out;
}

/** CSV field escaping per RFC 4180 (quote when it contains comma/quote/newline). */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Filters = { workspaceId: string; actions: string[]; actorUserId?: string; from?: Date; to?: Date; before?: Date };

function parseFilters(workspaceId: string, q: Record<string, unknown>, reply: FastifyReply): Filters | null {
  const rawAction = q.action;
  const actions = Array.isArray(rawAction) ? rawAction.map(String) : rawAction ? [String(rawAction)] : [];
  const parseDate = (v: unknown, field: string): Date | undefined | null => {
    if (v === undefined || v === "") return undefined;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) {
      validationError(reply, { [field]: `${field} must be an ISO timestamp.` });
      return null;
    }
    return d;
  };
  const from = parseDate(q.from, "from");
  if (from === null) return null;
  const to = parseDate(q.to, "to");
  if (to === null) return null;
  const before = parseDate(q.before, "before");
  if (before === null) return null;
  return {
    workspaceId,
    actions,
    actorUserId: q.actorUserId ? String(q.actorUserId) : undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    before: before ?? undefined,
  };
}

function whereFor(f: Filters): Prisma.AuditEventWhereInput {
  // Upper bound combines the cursor (`before`) and the `to` filter; use the earliest.
  const upper = f.before && f.to ? (f.before < f.to ? f.before : f.to) : (f.before ?? f.to);
  const createdAt: Prisma.DateTimeFilter = {};
  if (f.from) createdAt.gte = f.from;
  if (upper) createdAt.lt = upper;
  return {
    workspaceId: f.workspaceId,
    ...(f.actions.length ? { action: { in: f.actions } } : {}),
    ...(f.actorUserId ? { userId: f.actorUserId } : {}),
    ...(Object.keys(createdAt).length ? { createdAt } : {}),
  };
}

const eventSelect = {
  id: true,
  createdAt: true,
  action: true,
  targetType: true,
  targetId: true,
  ipAddress: true,
  userAgent: true,
  metadata: true,
  user: { select: { id: true, email: true, name: true } },
} satisfies Prisma.AuditEventSelect;

function toDto(e: Prisma.AuditEventGetPayload<{ select: typeof eventSelect }>) {
  return {
    id: e.id,
    createdAt: e.createdAt.toISOString(),
    action: e.action,
    actor: e.user ? { id: e.user.id, email: e.user.email, name: e.user.name } : null,
    targetType: e.targetType,
    targetId: e.targetId,
    ipAddress: e.ipAddress,
    userAgent: e.userAgent,
    metadata: redactAuditMetadata(e.metadata),
  };
}

/** Delete audit events older than each workspace's effective retention. Cloud-only; failure-safe. */
export async function pruneAuditEvents(): Promise<number> {
  const fallback = defaultRetentionDays();
  const cap = maxRetentionDays(); // 0 = no operator cap
  const workspaces = await prisma.workspace.findMany({ select: { id: true, auditRetentionDays: true } });
  let deleted = 0;
  for (const ws of workspaces) {
    let days = ws.auditRetentionDays ?? fallback;
    // Operator cap overrides per-workspace values, including "keep forever" (0).
    if (cap > 0) days = days <= 0 ? cap : Math.min(days, cap);
    if (days <= 0) continue; // keep forever (only possible when no cap is set)
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const res = await prisma.auditEvent.deleteMany({ where: { workspaceId: ws.id, createdAt: { lt: cutoff } } });
    if (res.count > 0) {
      deleted += res.count;
      console.info(`[audit-prune] workspace=${ws.id} deleted=${res.count} olderThanDays=${days}`);
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Tamper-evidence: a global, append-only hash chain over the audit log.
// Each checkpoint seals every event newer than the previous one and stores an
// HMAC over (prevHash + the covered events). Verification recomputes the chain
// from the stored rows; any in-place edit or insertion into a sealed range, or
// a hash break, is detected. Cloud-only.
// ---------------------------------------------------------------------------

function checkpointSecret(): string {
  return process.env.AUDIT_CHECKPOINT_SECRET || env.tokenHashSecret;
}

/** Deterministic JSON with recursively sorted keys, so metadata hashes stably. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

const chainSelect = {
  id: true,
  createdAt: true,
  action: true,
  userId: true,
  workspaceId: true,
  targetType: true,
  targetId: true,
  metadata: true,
} satisfies Prisma.AuditEventSelect;
type ChainEvent = Prisma.AuditEventGetPayload<{ select: typeof chainSelect }>;

function serializeEvent(e: ChainEvent): string {
  // Unit-separator joined; covers every persisted field so any edit changes the hash.
  return [
    e.id,
    e.createdAt.toISOString(),
    e.action,
    e.userId ?? "",
    e.workspaceId ?? "",
    e.targetType,
    e.targetId ?? "",
    stableStringify(e.metadata),
  ].join("␟");
}

function computeChainHash(prevHash: string | null, events: ChainEvent[]): string {
  const h = createHmac("sha256", checkpointSecret());
  h.update(prevHash ?? "");
  for (const e of events) {
    h.update("\n");
    h.update(serializeEvent(e));
  }
  return h.digest("hex");
}

type Cursor = { createdAt: Date; id: string };

// Events strictly after `lower` (exclusive) and up to `upper` (inclusive), in chain order.
function rangeWhere(lower: Cursor | null, upper: Cursor | null): Prisma.AuditEventWhereInput {
  const and: Prisma.AuditEventWhereInput[] = [];
  if (lower) {
    and.push({ OR: [{ createdAt: { gt: lower.createdAt } }, { createdAt: lower.createdAt, id: { gt: lower.id } }] });
  }
  if (upper) {
    and.push({ OR: [{ createdAt: { lt: upper.createdAt } }, { createdAt: upper.createdAt, id: { lte: upper.id } }] });
  }
  return and.length ? { AND: and } : {};
}

/** Seal all events newer than the last checkpoint into a new chained checkpoint. Returns null when nothing is pending. */
export async function createAuditCheckpoint(): Promise<{ id: string; eventCount: number; throughCreatedAt: Date } | null> {
  const last = await prisma.auditCheckpoint.findFirst({ orderBy: { createdAt: "desc" } });
  const lower = last ? { createdAt: last.throughCreatedAt, id: last.throughId } : null;
  const events = await prisma.auditEvent.findMany({
    where: rangeWhere(lower, null),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: chainSelect,
  });
  if (events.length === 0) return null;
  const prevHash = last?.hash ?? null;
  const hash = computeChainHash(prevHash, events);
  const lastEvent = events[events.length - 1]!;
  const cp = await prisma.auditCheckpoint.create({
    data: { throughCreatedAt: lastEvent.createdAt, throughId: lastEvent.id, eventCount: events.length, prevHash, hash },
  });
  return { id: cp.id, eventCount: cp.eventCount, throughCreatedAt: cp.throughCreatedAt };
}

export type ChainVerification = {
  ok: boolean;
  checkpoints: number;
  verified: number;
  pruned: number;
  brokenCheckpointId: string | null;
  lastCheckpointAt: string | null;
  lastSealedAt: string | null;
  pendingCount: number;
};

/**
 * Walk the checkpoint chain oldest→newest and recompute each hash from the
 * surviving rows. Retention pruning only ever removes the OLDEST events, so a
 * contiguous prefix of checkpoints may be missing rows ("pruned") — those are
 * trusted via their stored hash. Once a checkpoint verifies in full, every
 * later checkpoint must match exactly: a shrunk count (deletion) or grown count
 * (insertion) or hash mismatch after that point is reported as tampering.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const checkpoints = await prisma.auditCheckpoint.findMany({ orderBy: { createdAt: "asc" } });
  let prevHash: string | null = null;
  let lower: Cursor | null = null;
  let inPrunablePrefix = true;
  let verified = 0;
  let pruned = 0;
  const last = checkpoints[checkpoints.length - 1] ?? null;

  for (const cp of checkpoints) {
    const upper: Cursor = { createdAt: cp.throughCreatedAt, id: cp.throughId };
    const events = await prisma.auditEvent.findMany({
      where: rangeWhere(lower, upper),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: chainSelect,
    });
    if (events.length === cp.eventCount) {
      if (computeChainHash(prevHash, events) !== cp.hash) {
        return broken(cp.id, checkpoints.length, verified, pruned, last);
      }
      inPrunablePrefix = false;
      verified++;
    } else if (events.length < cp.eventCount && inPrunablePrefix) {
      pruned++; // older events aged out by retention — trust the stored hash and continue.
    } else {
      return broken(cp.id, checkpoints.length, verified, pruned, last);
    }
    prevHash = cp.hash;
    lower = upper;
  }

  const pendingCount = await prisma.auditEvent.count({ where: rangeWhere(lower, null) });
  return {
    ok: true,
    checkpoints: checkpoints.length,
    verified,
    pruned,
    brokenCheckpointId: null,
    lastCheckpointAt: last ? last.createdAt.toISOString() : null,
    lastSealedAt: last ? last.throughCreatedAt.toISOString() : null,
    pendingCount,
  };
}

function broken(
  id: string,
  total: number,
  verified: number,
  pruned: number,
  last: { createdAt: Date; throughCreatedAt: Date } | null,
): ChainVerification {
  return {
    ok: false,
    checkpoints: total,
    verified,
    pruned,
    brokenCheckpointId: id,
    lastCheckpointAt: last ? last.createdAt.toISOString() : null,
    lastSealedAt: last ? last.throughCreatedAt.toISOString() : null,
    pendingCount: 0,
  };
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

export async function registerAuditLogRoutes(app: FastifyInstance): Promise<void> {
  // Viewing (list/export) is allowed for admins OR members granted canViewAudit.
  // Mutating retention stays admin-only (`requireAdmin`).
  async function gate(
    request: FastifyRequest,
    reply: FastifyReply,
    workspaceId: string,
    mode: "view" | "admin",
  ): Promise<boolean> {
    if (!cloudHostedEnabled()) {
      notFound(reply, "Not found.");
      return false;
    }
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    if (await canManageWorkspace(auth.userId, workspaceId)) return true;
    if (mode === "view") {
      const m = await prisma.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: auth.userId } },
        select: { canViewAudit: true },
      });
      if (m?.canViewAudit) return true;
    }
    notFound(reply, "Workspace not found.");
    return false;
  }
  const requireViewer = (req: FastifyRequest, reply: FastifyReply, ws: string) => gate(req, reply, ws, "view");
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply, ws: string) => gate(req, reply, ws, "admin");

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/workspaces/:id/audit",
    async (request, reply) => {
      const workspaceId = request.params.id;
      if (!(await requireViewer(request, reply, workspaceId))) return reply;
      const filters = parseFilters(workspaceId, request.query, reply);
      if (!filters) return reply;
      const rawLimit = Number(request.query.limit ?? DEFAULT_PAGE);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_PAGE) : DEFAULT_PAGE;

      const rows = await prisma.auditEvent.findMany({
        where: whereFor(filters),
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        select: eventSelect,
      });
      const nextRow = rows.length > limit ? rows.pop() ?? null : null;
      return { events: rows.map(toDto), next: nextRow ? nextRow.createdAt.toISOString() : null };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    "/api/workspaces/:id/audit/export",
    async (request, reply) => {
      const workspaceId = request.params.id;
      if (!(await requireViewer(request, reply, workspaceId))) return reply;
      const format = String(request.query.format ?? "csv");
      if (format !== "csv" && format !== "json") return validationError(reply, { format: "format must be csv or json." });
      const filters = parseFilters(workspaceId, request.query, reply);
      if (!filters) return reply;

      const rows = await prisma.auditEvent.findMany({
        where: whereFor(filters),
        orderBy: { createdAt: "desc" },
        take: AUDIT_EXPORT_CAP + 1,
        select: eventSelect,
      });
      const truncated = rows.length > AUDIT_EXPORT_CAP;
      if (truncated) rows.pop();
      const events = rows.map(toDto);
      const stamp = new Date().toISOString().slice(0, 10);
      const base = reply
        .header("content-disposition", `attachment; filename="audit-${workspaceId}-${stamp}.${format}"`)
        .header("x-content-type-options", "nosniff")
        .header("x-audit-export-truncated", truncated ? "true" : "false");

      if (format === "json") {
        return base
          .header("content-type", "application/json; charset=utf-8")
          .send(JSON.stringify({ events, truncated, cap: AUDIT_EXPORT_CAP }, null, 2));
      }

      const header = ["createdAt", "action", "actorEmail", "targetType", "targetId", "ipAddress", "userAgent", "metadata"];
      const lines = [header.join(",")];
      for (const dto of events) {
        lines.push(
          [
            dto.createdAt,
            dto.action,
            dto.actor?.email ?? "",
            dto.targetType,
            dto.targetId ?? "",
            dto.ipAddress ?? "",
            dto.userAgent ?? "",
            dto.metadata ? JSON.stringify(dto.metadata) : "",
          ]
            .map(csvCell)
            .join(","),
        );
      }
      if (truncated) lines.push(csvCell(`[truncated to ${AUDIT_EXPORT_CAP} most-recent rows — narrow the filters]`));
      return base.header("content-type", "text/csv; charset=utf-8").send(`${lines.join("\n")}\n`);
    },
  );

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/settings/audit-retention", async (request, reply) => {
    const workspaceId = request.params.id;
    if (!(await requireAdmin(request, reply, workspaceId))) return reply;
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { auditRetentionDays: true } });
    if (!ws) return notFound(reply, "Workspace not found.");
    return { auditRetentionDays: ws.auditRetentionDays };
  });

  app.put<{ Params: { id: string }; Body: { auditRetentionDays?: number | null } }>(
    "/api/workspaces/:id/settings/audit-retention",
    async (request, reply) => {
      const workspaceId = request.params.id;
      if (!(await requireAdmin(request, reply, workspaceId))) return reply;
      const value = request.body?.auditRetentionDays ?? null;
      if (value !== null) {
        if (!Number.isInteger(value) || value < 0 || value > 3650) {
          return validationError(reply, { auditRetentionDays: "Must be null, 0 (keep forever), or 1–3650 days." });
        }
      }
      const ws = await prisma.workspace.update({
        where: { id: workspaceId },
        data: { auditRetentionDays: value },
        select: { auditRetentionDays: true },
      });
      return { auditRetentionDays: ws.auditRetentionDays };
    },
  );

  // Account-security log: the signed-in user's OWN audit events across every
  // workspace, plus account-level events with no workspace (logins, token use).
  // Not admin-gated — it only ever returns `userId = me`. Cloud-only.
  app.get<{ Querystring: Record<string, unknown> }>("/api/me/account-activity", async (request, reply) => {
    if (!cloudHostedEnabled()) return notFound(reply, "Not found.");
    const auth = await requireAuth(request);
    requireTokenScope(auth, "read");
    const filters = parseFilters("", request.query, reply);
    if (!filters) return reply;
    const rawLimit = Number(request.query.limit ?? DEFAULT_PAGE);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_PAGE) : DEFAULT_PAGE;

    // Reuse whereFor's date/action logic but pin the actor to the caller and
    // drop the workspace constraint (account events may have workspaceId=null).
    const { workspaceId: _ws, ...rest } = whereFor(filters);
    const rows = await prisma.auditEvent.findMany({
      where: { ...rest, userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      select: eventSelect,
    });
    const nextRow = rows.length > limit ? rows.pop() ?? null : null;
    return { events: rows.map(toDto), next: nextRow ? nextRow.createdAt.toISOString() : null };
  });

  // Tamper-evidence: seal pending events into a new checkpoint (admin, on demand).
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/audit/checkpoint", async (request, reply) => {
    if (!(await requireAdmin(request, reply, request.params.id))) return reply;
    const created = await createAuditCheckpoint();
    return {
      created: created !== null,
      checkpoint: created ? { id: created.id, eventCount: created.eventCount, throughCreatedAt: created.throughCreatedAt.toISOString() } : null,
    };
  });

  // Tamper-evidence: verify the whole checkpoint chain against the stored rows.
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/audit/integrity", async (request, reply) => {
    if (!(await requireAdmin(request, reply, request.params.id))) return reply;
    return verifyAuditChain();
  });

  // Daily prune timer — cloud-only, failure-safe, and unref'd so it never blocks exit/tests.
  if (cloudHostedEnabled() && !pruneTimer) {
    pruneTimer = setInterval(() => {
      void pruneAuditEvents().catch((err) => console.error("[audit-prune] failed:", err));
    }, PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
  }

  // Hourly checkpoint timer — cloud-only, failure-safe, unref'd.
  if (cloudHostedEnabled() && !checkpointTimer) {
    checkpointTimer = setInterval(() => {
      void createAuditCheckpoint().catch((err) => console.error("[audit-checkpoint] failed:", err));
    }, CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref?.();
  }
}
