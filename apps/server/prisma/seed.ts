import { PrismaClient } from "@prisma/client";
import { env } from "../src/env.js";
import { hashPassword } from "../src/passwords.js";

// Bootstrap the first workspace + admin (resolves the chicken-and-egg, review H6).
// Reads BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD from the environment.
const prisma = new PrismaClient();

async function main() {
  if (!env.bootstrapAdminEmail || !env.bootstrapAdminPassword) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD to seed.");
  }

  const email = env.bootstrapAdminEmail.trim().toLowerCase();
  const passwordHash = await hashPassword(env.bootstrapAdminPassword);

  await prisma.$transaction(async (tx) => {
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
      },
    });

    await tx.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: { role: "admin" },
      create: { workspaceId: workspace.id, userId: user.id, role: "admin" },
    });

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
  });

  console.log(`Bootstrapped admin ${email}.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
