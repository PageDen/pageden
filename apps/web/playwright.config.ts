import { defineConfig, devices } from "@playwright/test";

// Secrets come from the environment only (CI generates them; locally you export them) so no
// secret-shaped literals are committed. The API server + web dev server are booted by
// Playwright; the dev server proxies /api → :4000 so the session cookie stays first-party.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`E2E requires env var ${name}`);
  return v;
}

const serverEnv = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: required("DATABASE_URL"),
  SESSION_SECRET: required("SESSION_SECRET"),
  TOKEN_HASH_SECRET: required("TOKEN_HASH_SECRET"),
  WEB_ORIGIN: "http://localhost:3000",
  STORAGE_ROOT: process.env.STORAGE_ROOT ?? "./.e2e-storage",
  BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test",
  BOOTSTRAP_ADMIN_PASSWORD: required("BOOTSTRAP_ADMIN_PASSWORD"),
  RATE_LIMIT_MAX: "1000000",
  LOGIN_RATE_LIMIT_MAX: "1000000",
};

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://localhost:3000", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @pageden/server dev",
      cwd: "../..",
      url: "http://localhost:4000/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: serverEnv,
    },
    {
      command: "pnpm --filter @pageden/web dev",
      cwd: "../..",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { API_PROXY_TARGET: "http://localhost:4000", VITE_API_BASE_URL: "/api" },
    },
  ],
});
