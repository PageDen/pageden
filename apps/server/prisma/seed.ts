import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { env } from "../src/env.js";
import { hashPassword } from "../src/passwords.js";

// Bootstrap the first workspace + admin (resolves the chicken-and-egg, review H6).
// Reads BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD from the environment.
const prisma = new PrismaClient();

type SeedClient = PrismaClient;

export async function bootstrapAdminSeed(
  input: { email: string; password: string },
  client: SeedClient = prisma,
): Promise<{ email: string }> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);

  await client.$transaction(async (tx) => {
    const workspace = await tx.workspace.upsert({
      where: { slug: "default" },
      update: {},
      create: { name: "Default Workspace", slug: "default" },
    });

    const user = await tx.user.upsert({
      where: { email },
      update: { name: "Bootstrap Admin", passwordHash },
      create: {
        email,
        name: "Bootstrap Admin",
        passwordHash,
        emailVerified: true,
        // Provisioned admin with a seeded workspace — not a first-run signup, so
        // skip the onboarding redirect.
        onboardedAt: new Date(),
      },
    });

    await tx.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: { role: "admin" },
      create: { workspaceId: workspace.id, userId: user.id, role: "admin" },
    });

    const existingBootstrapAudit = await tx.auditEvent.findFirst({
      where: {
        workspaceId: workspace.id,
        userId: user.id,
        action: "bootstrap_admin_seeded",
        targetType: "user",
        targetId: user.id,
      },
      select: { id: true },
    });

    if (!existingBootstrapAudit) {
      await tx.auditEvent.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          action: "bootstrap_admin_seeded",
          targetType: "user",
          targetId: user.id,
          metadata: { email },
        },
      });
    }
  });

  return { email };
}

async function main() {
  if (!env.bootstrapAdminEmail || !env.bootstrapAdminPassword) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD to seed.");
  }

  const result = await bootstrapAdminSeed({ email: env.bootstrapAdminEmail, password: env.bootstrapAdminPassword });
  console.log(`Bootstrapped admin ${result.email}.`);
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
