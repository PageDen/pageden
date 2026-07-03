import { defineConfig, devices } from "@playwright/test";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Real-agent E2E requires env var ${name}`);
  return value;
}

const repo = "../..";
const apiPort = process.env.REAL_AGENT_E2E_API_PORT ?? "4100";
const webPort = process.env.REAL_AGENT_E2E_WEB_PORT ?? "3000";
const webOrigin = `http://localhost:${webPort}`;
const apiOrigin = `http://localhost:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "real-two-agent-planning.manual.spec.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: webOrigin, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @pageden/server exec dotenv -e ../../.env.test -e ../../.env -- tsx watch src/index.ts",
      cwd: repo,
      url: `${apiOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        PORT: apiPort,
        DATABASE_URL: required("DATABASE_URL"),
        SESSION_SECRET: required("SESSION_SECRET"),
        TOKEN_HASH_SECRET: required("TOKEN_HASH_SECRET"),
        WEB_ORIGIN: webOrigin,
        STORAGE_ROOT: process.env.STORAGE_ROOT ?? "./.e2e-storage",
        BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test",
        BOOTSTRAP_ADMIN_PASSWORD: required("BOOTSTRAP_ADMIN_PASSWORD"),
        RATE_LIMIT_MAX: "1000000",
        LOGIN_RATE_LIMIT_MAX: "1000000",
        CLOUD_HOSTED: "true",
        BASE_DOMAIN: "localhost",
      },
    },
    {
      command: "pnpm --filter @pageden/web dev",
      cwd: repo,
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_PROXY_TARGET: apiOrigin,
        VITE_API_BASE_URL: "/api",
      },
    },
  ],
});
