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
        "src/test-helpers.ts",
        "src/loop/types.ts",
        "src/types/events.ts",
        "src/types/parameter-history.ts",
        "src/types/index.ts",
        "src/loop/orchestrator.ts",
      ],
    },
  },
});
