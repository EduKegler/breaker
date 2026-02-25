import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: true,
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.e2e.ts",
        "src/automation/e2e/**",
        "src/automation/login.ts",
        "src/test-helpers.ts",
        "src/loop/types.ts",
        "src/types/events.ts",
        "src/types/parameter-history.ts",
        "src/types/parse-results.ts",
        "src/types/index.ts",
        "src/automation/run-backtest.ts",
        "src/loop/orchestrator.ts",
      ],
    },
  },
});
