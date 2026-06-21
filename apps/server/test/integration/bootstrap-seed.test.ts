import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapAdminSeed } from "../../prisma/seed.js";
import { prisma, resetDb } from "../helpers/db.js";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("bootstrap admin seed", () => {
  it("can be run repeatedly without duplicating the bootstrap audit event", async () => {
    const input = {
      email: "Admin@Example.com",
      password: "correct horse battery staple",
    };

    await bootstrapAdminSeed(input, prisma);
    await bootstrapAdminSeed(input, prisma);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "default" } });

    await expect(
      prisma.workspaceMembership.count({ where: { workspaceId: workspace.id, userId: user.id, role: "admin" } }),
    ).resolves.toBe(1);
    await expect(
      prisma.auditEvent.count({
        where: {
          workspaceId: workspace.id,
          userId: user.id,
          action: "bootstrap_admin_seeded",
          targetType: "user",
          targetId: user.id,
        },
      }),
    ).resolves.toBe(1);
  });
});
