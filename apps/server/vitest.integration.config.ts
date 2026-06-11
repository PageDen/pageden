import { defineConfig } from "vitest/config";

// Integration/contract/security project: requires a reachable Postgres (DATABASE_URL).
// Files run serially since they share one database; each file resets state per test.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
