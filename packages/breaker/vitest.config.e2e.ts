import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/automation/e2e/**/*.e2e.ts"],
    globals: true,
    testTimeout: 180_000, // 3 min per test
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
