// Server-side vault import endpoints (see pageden-dev docs/SERVER-SIDE-VAULT-IMPORT-PLAN.md).
//
// POST /api/import/vault           — upload one zip; 202 { jobId } once stored; async processing
// GET  /api/import/jobs/:id        — poll status/progress/report
// POST /api/import/jobs/:id/retry  — re-run a failed job from its stored zip

import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { prisma } from "../prisma.js";
import { requireAuth, requireTokenScope } from "../auth.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { atLeast, canManageWorkspace, resolveFolderRole } from "../permissions/index.js";
import { importZipKey, writeImportZip } from "../storage.js";
import {
  failInterruptedImportJobs,
  importJobMaintenance,
  kickImportWorker,
  newImportJobId,
  IMPORT_LIMITS,
  type ImportJobParams,
} from "./vault.js";

function jobDto(job: {
  id: string;
  workspaceId: string;
  status: string;
  progress: unknown;
  report: unknown;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    status: job.status as "queued" | "running" | "done" | "failed",
    progress: job.progress ?? null,
    report: job.report ?? null,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (instance) => {
    // The zip body is consumed as a raw stream — never parsed or buffered by Fastify.
    instance.addContentTypeParser(["application/zip", "application/x-zip-compressed", "application/octet-stream"], (_req, payload, done) =>
      done(null, payload),
    );

    instance.post<{
      Querystring: { workspaceId?: string; targetFolderId?: string; targetRootName?: string; conflictPolicy?: string };
    }>(
      "/api/import/vault",
      { bodyLimit: IMPORT_LIMITS.maxZipBytes() + 1024 },
      async (request, reply) => {
        const auth = await requireAuth(request);
        requireTokenScope(auth, "create");
        const { workspaceId, targetFolderId, targetRootName } = request.query;
        const conflictPolicy = request.query.conflictPolicy === "rename" ? "rename" : "skip";
        if (!workspaceId) return validationError(reply, { workspaceId: "workspaceId is required." });
        if (Boolean(targetFolderId) === Boolean(targetRootName?.trim())) {
          return validationError(reply, { target: "Provide exactly one of targetFolderId or targetRootName." });
        }

        const length = Number(request.headers["content-length"]);
        if (!Number.isFinite(length) || length <= 0) {
          return reply.code(411).send({ error: "length_required", message: "Content-Length is required." });
        }
        if (length > IMPORT_LIMITS.maxZipBytes()) {
          return reply.code(413).send({ error: "too_large", message: "Zip exceeds the maximum import size." });
        }

        // Destination permission preflight (re-checked by the worker before any write).
        if (targetFolderId) {
          const folder = await prisma.folder.findFirst({
            where: { id: targetFolderId, workspaceId, deletedAt: null },
            select: { id: true },
          });
          if (!folder) return notFound(reply, "Target folder not found.");
          const role = await resolveFolderRole(auth.userId, folder.id);
          if (role === null) return notFound(reply, "Target folder not found.");
          if (!atLeast(role, "editor")) return forbidden(reply);
        } else if (!(await canManageWorkspace(auth.userId, workspaceId))) {
          return forbidden(reply, "Only workspace admins can create a new top-level folder.");
        }

        // One active job per user.
        const active = await prisma.importJob.findFirst({
          where: { userId: auth.userId, status: { in: ["queued", "running"] } },
          select: { id: true },
        });
        if (active) {
          return reply.code(409).send({ error: "import_in_progress", message: "Another import is already running.", jobId: active.id });
        }

        const jobId = newImportJobId();
        const storageKey = importZipKey(workspaceId, jobId);
        await writeImportZip(storageKey, request.body as Readable, length);

        const params: ImportJobParams = targetFolderId
          ? { conflictPolicy, targetFolderId }
          : { conflictPolicy, targetRootName: targetRootName!.trim() };
        const job = await prisma.importJob.create({
          data: { id: jobId, workspaceId, userId: auth.userId, status: "queued", params: params as object, storageKey },
        });
        kickImportWorker();
        return reply.code(202).send({ jobId: job.id });
      },
    );
  });

  app.get<{ Params: { id: string } }>("/api/import/jobs/:id", async (request, reply) => {
    const auth = await requireAuth(request);
    const job = await prisma.importJob.findUnique({ where: { id: request.params.id } });
    if (!job) return notFound(reply, "Import job not found.");
    if (job.userId !== auth.userId && !(await canManageWorkspace(auth.userId, job.workspaceId))) {
      return notFound(reply, "Import job not found."); // existence-hiding
    }
    return jobDto(job);
  });

  app.post<{ Params: { id: string } }>("/api/import/jobs/:id/retry", async (request, reply) => {
    const auth = await requireAuth(request);
    const job = await prisma.importJob.findUnique({ where: { id: request.params.id } });
    if (!job) return notFound(reply, "Import job not found.");
    if (job.userId !== auth.userId) return notFound(reply, "Import job not found.");
    if (job.status !== "failed") {
      return reply.code(409).send({ error: "not_retryable", message: "Only failed imports can be retried." });
    }
    // Keep the report — it carries the per-entry checkpoint that makes rename retries safe.
    const updated = await prisma.importJob.updateMany({
      where: { id: job.id, status: "failed" },
      data: { status: "queued", error: null, finishedAt: null },
    });
    if (updated.count !== 1) return reply.code(409).send({ error: "not_retryable", message: "Only failed imports can be retried." });
    kickImportWorker();
    return reply.code(202).send({ jobId: job.id });
  });

  // Boot: fail jobs interrupted by the restart (retryable), then resume any queued ones.
  void failInterruptedImportJobs().then(() => kickImportWorker());
  // Watchdog + 24h cleanup of finished jobs and their zips.
  const interval = setInterval(() => {
    void importJobMaintenance().catch(() => {});
  }, 60_000);
  interval.unref();
  app.addHook("onClose", async () => clearInterval(interval));
}
