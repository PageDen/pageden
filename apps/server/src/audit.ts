import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./prisma.js";

export interface AuditInput {
  workspaceId?: string | null;
  userId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function writeAuditEvent(
  input: AuditInput,
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<void> {
  await client.auditEvent.create({
    data: {
      workspaceId: input.workspaceId ?? null,
      userId: input.userId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ?? undefined,
    },
  });
}
