import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
