import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // job-runner.ts is a 40-line entrypoint whose only real coverage comes
      // from spawning the built artifact in a separate process
      // (job-runner.test.ts, job-concurrency.test.ts) — v8 coverage in THIS
      // process cannot see that, so it reports a misleading 0%.
      // index.ts/version.ts are re-export and package-version shims.
      //
      // Deliberately NOT excluded: dispatchers/shared/subprocess.ts, which
      // sits at ~4% statements / 0% functions because six suites vi.mock it
      // away. That is a real gap (see the mock-detection branch in
      // stream-subprocess.ts), and hiding it behind an exclude would convert
      // a visible problem into an invisible one.
      exclude: ["src/index.ts", "src/version.ts", "src/job-runner.ts"],
      reporter: ["text", "lcov"],
      /**
       * Ratchets, set a point or two under the measured numbers rather than at
       * them. Two consecutive runs of the identical tree differ slightly
       * (measured 2026-08-17: 82.60/86.71 then 82.65/86.52) because the
       * concurrency suite spawns real processes whose scheduling varies.
       * Thresholds pinned exactly at an observed value would fail
       * intermittently, which is the one failure mode worse than having no
       * threshold at all.
       *
       * Raise them when coverage rises. The thin spots behind these numbers
       * are bin.ts (~56%), dispatchers/shared/subprocess.ts (~4%, mocked away
       * by six suites) and mcp/config-hot-reload.ts.
       */
      thresholds: {
        statements: 80,
        branches: 74,
        functions: 84,
        lines: 82,
      },
    },
  },
});
