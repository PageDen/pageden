import { defineConfig } from "vitest/config";

// Unit project: pure logic, no database. Runs everywhere via `pnpm test`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["test/helpers/unit-setup.ts"],
    environment: "node",
  },
});
