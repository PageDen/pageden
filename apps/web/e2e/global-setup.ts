import { execSync } from "node:child_process";

// Migrate + seed the bootstrap admin before the servers start.
export default function globalSetup() {
  const env = { ...process.env };
  execSync("pnpm --filter @pageden/server db:migrate", { cwd: "../..", stdio: "inherit", env });
  execSync("pnpm --filter @pageden/server db:seed", { cwd: "../..", stdio: "inherit", env });
}
