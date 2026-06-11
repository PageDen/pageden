import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { requireAuth } from "../auth.js";
import { writeAuditEvent } from "../audit.js";
import { createRawToken, hashToken } from "../tokens.js";
import { validationError, notFound } from "../errors.js";

const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/L
const USER_CODE_LEN = 8;
const EXPIRES_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 5;

function randomFrom(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function displayUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  // Plugin starts a pairing request (no auth).
  app.post("/api/auth/device/start", async (request, reply) => {
    const userCode = randomFrom(USER_CODE_ALPHABET, USER_CODE_LEN);
    const deviceCode = createRawToken();
    await prisma.deviceAuthRequest.create({
      data: {
        userCode,
        deviceCodeHash: hashToken(deviceCode, env.tokenHashSecret),
        expiresAt: new Date(Date.now() + EXPIRES_MS),
        ipAddress: request.ip,
      },
    });
    await writeAuditEvent({
      action: "device_auth_started",
      targetType: "device_auth",
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    return reply.code(201).send({
      deviceCode,
      userCode: displayUserCode(userCode),
      verificationUri: `${env.webOrigin}/devices`,
      expiresIn: Math.floor(EXPIRES_MS / 1000),
      interval: POLL_INTERVAL_SECONDS,
    });
  });

  // Plugin polls with the device code; receives a token once, after approval.
  app.post<{ Body: { deviceCode?: string } }>(
    "/api/auth/device/poll",
    { config: { rateLimit: { max: Number(process.env.POLL_RATE_LIMIT_MAX ?? 60), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const deviceCode = request.body.deviceCode;
      if (!deviceCode) return validationError(reply, { deviceCode: "deviceCode is required." });
      const found = await prisma.deviceAuthRequest.findUnique({
        where: { deviceCodeHash: hashToken(deviceCode, env.tokenHashSecret) },
      });
      if (!found || found.expiresAt <= new Date()) return { status: "expired" as const };
      if (found.status === "pending") return { status: "pending" as const };
      if (found.status === "denied") return { status: "denied" as const };
      if (found.status === "consumed") return { status: "consumed" as const };

      // approved → mint a token exactly once, in a transaction guarded against double-mint.
      const rawToken = createRawToken();
      const result = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string; userId: string | null }>>`
          SELECT "status", "userId" FROM "DeviceAuthRequest" WHERE "id" = ${found.id} FOR UPDATE`;
        const row = locked[0];
        if (!row || row.status !== "approved" || !row.userId) return { minted: false as const };
        const token = await tx.apiToken.create({
          data: { userId: row.userId, name: "Obsidian (device login)", tokenHash: hashToken(rawToken, env.tokenHashSecret) },
        });
        await tx.deviceAuthRequest.update({ where: { id: found.id }, data: { status: "consumed", tokenId: token.id } });
        await writeAuditEvent(
          { userId: row.userId, action: "device_auth_token_issued", targetType: "api_token", targetId: token.id },
          tx,
        );
        return { minted: true as const };
      });
      if (!result.minted) return { status: "consumed" as const };
      return { status: "approved" as const, token: rawToken };
    },
  );

  // Web app: look up a pending request so the user can verify origin/age before approving
  // (mitigates device-code phishing — informed consent). Cookie-authed + rate-limited.
  app.get<{ Querystring: { userCode?: string } }>(
    "/api/auth/device/lookup",
    { config: { rateLimit: { max: Number(process.env.DEVICE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      await requireAuth(request);
      const userCode = request.query.userCode ? normalizeUserCode(request.query.userCode) : "";
      if (!userCode) return validationError(reply, { userCode: "userCode is required." });
      const found = await prisma.deviceAuthRequest.findFirst({
        where: { userCode, status: "pending", expiresAt: { gt: new Date() } },
        select: { ipAddress: true, createdAt: true },
      });
      if (!found) return notFound(reply, "That code is invalid or has expired.");
      return { ipAddress: found.ipAddress, createdAt: found.createdAt.toISOString() };
    },
  );

  // The signed-in user approves or denies a device by its short code. The state transition is
  // atomic (conditional UPDATE) so concurrent approve/deny cannot interleave.
  app.post<{ Body: { userCode?: string; action?: string } }>(
    "/api/auth/device/approve",
    { config: { rateLimit: { max: Number(process.env.DEVICE_RATE_LIMIT_MAX ?? 30), timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = await requireAuth(request);
      const userCode = request.body.userCode ? normalizeUserCode(request.body.userCode) : "";
      const action = request.body.action === "deny" ? "deny" : "approve";
      if (!userCode) return validationError(reply, { userCode: "userCode is required." });

      const result = await prisma.deviceAuthRequest.updateMany({
        where: { userCode, status: "pending", expiresAt: { gt: new Date() } },
        data:
          action === "approve"
            ? { status: "approved", userId: auth.userId, approvedAt: new Date() }
            : { status: "denied" },
      });
      if (result.count === 0) return notFound(reply, "That code is invalid or has expired.");
      await writeAuditEvent({
        userId: auth.userId,
        action: action === "approve" ? "device_auth_approved" : "device_auth_denied",
        targetType: "device_auth",
        ipAddress: request.ip,
        metadata: { userCode },
      });
      return { ok: true };
    },
  );
}

/** Delete expired and terminal (consumed/denied) device requests. */
export async function cleanupDeviceRequests(): Promise<{ removed: number }> {
  const r = await prisma.deviceAuthRequest.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { status: { in: ["consumed", "denied"] } }] },
  });
  return { removed: r.count };
}
