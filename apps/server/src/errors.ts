import type { FastifyReply } from "fastify";

export function validationError(reply: FastifyReply, fields: Record<string, string>) {
  return reply.code(400).send({ error: "validation_error", fields });
}
export function forbidden(reply: FastifyReply, message = "You do not have permission to perform this action.") {
  return reply.code(403).send({ error: "forbidden", message });
}
export function notFound(reply: FastifyReply, message = "Resource not found.") {
  return reply.code(404).send({ error: "not_found", message });
}
export function conflict(reply: FastifyReply, currentVersion: string, message: string) {
  return reply.code(409).send({ error: "conflict", currentVersion, message });
}

/**
 * Postgres unique-violation (SQLSTATE 23505) — backstop behind explicit pre-checks.
 * Prisma surfaces partial-index violations inconsistently (P2002, or P2010 with meta.code,
 * or an unknown-request error where the only signal is the message), so check all of them.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown };
  if (e.code === "P2002") return true;
  if (e.code === "23505") return true;
  if (e.code === "P2010" && e.meta?.code === "23505") return true;
  const text = `${String(e.meta?.message ?? "")}\n${String(e.message ?? "")}`;
  return /\b23505\b/.test(text) || /duplicate key value violates unique constraint/i.test(text);
}
