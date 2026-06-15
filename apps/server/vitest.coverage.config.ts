import { defineConfig } from "vitest/config";

// Combined unit + integration run WITH code coverage over src/. Requires a reachable Postgres
// (DATABASE_URL) like the integration project — most route/business-logic coverage comes from
// the integration tests. Used by CI as a coverage gate: it fails if coverage drops below the
// thresholds below, which is what catches new code shipped without tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
    // @vitest/coverage-v8@2.1.9 intermittently crashes its default tinypool
    // thread worker on CI with "Worker exited unexpectedly" right after the
    // last test file finishes — every test passes but vitest exits non-zero,
    // failing the coverage gate. Use the forks pool (Node child_process) so
    // each test file runs in its own short-lived process; that sidesteps the
    // worker-thread bug while keeping the per-file module isolation our
    // tests rely on (each file's afterAll disconnects prisma + closes the
    // shared Fastify app, which only works if the module is per-file).
    pool: "forks",
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      reporter: ["text-summary", "text"],
      // Keep the main coverage gate above 92% while branch coverage is raised separately.
      thresholds: { statements: 92, branches: 70, functions: 92, lines: 92 },
    },
  },
});
