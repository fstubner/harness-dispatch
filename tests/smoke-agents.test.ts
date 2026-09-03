import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildShortTaskPrompt,
  buildTaskBrief,
  smokeWorkspaceRoot,
} from // scripts/ is plain JS with no declarations; this suite exercises it directly.
// @ts-expect-error -- untyped local module
"../scripts/smoke-agents.mjs";

describe("live agent smoke task brief", () => {
  it("keeps the routed prompt short and puts detailed instructions in the workspace brief", () => {
    const briefPath = "C:\\tmp\\fixture\\.harness-dispatch\\agent-task.md";
    const prompt = buildShortTaskPrompt(briefPath);
    const brief = buildTaskBrief("codex", "C:\\tmp\\fixture");

    expect(prompt.length).toBeLessThan(180);
    expect(prompt).toContain(briefPath);
    expect(prompt).not.toContain("Fix the failing Node.js test");

    expect(brief).toContain("Fix the failing Node.js test");
    expect(brief).toContain("Do not modify `test.mjs`");
    expect(brief).toContain("Do not modify `package.json`");
    expect(brief).toContain("Do not modify `AGENTS.md`");
    expect(brief).toContain("Do not modify this task brief");
  });

  it("uses a project-local shared smoke workspace by default", () => {
    const previous = process.env.HARNESS_DISPATCH_AGENT_SMOKE_ROOT;
    delete process.env.HARNESS_DISPATCH_AGENT_SMOKE_ROOT;
    try {
      const root = smokeWorkspaceRoot(process.cwd());
      expect(path.isAbsolute(root)).toBe(true);
      expect(root.endsWith(path.join(".harness-dispatch", "smoke-workspaces"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HARNESS_DISPATCH_AGENT_SMOKE_ROOT;
      else process.env.HARNESS_DISPATCH_AGENT_SMOKE_ROOT = previous;
    }
  });
});

describe("live agent smoke isolates the state it writes", () => {
  /**
   * The smoke script isolated quota counters (stateFile: ":memory-smoke:")
   * and NOT breaker state — Router falls back to a BreakerStore pointed at
   * the user's real state directory. Observed live 2026-08-20: a codex quota
   * limit hit during a smoke run left codex_cli circuit-broken in the actual
   * install. Accurate that time, but a smoke failure for any unrelated reason
   * would block a healthy route for real dispatches.
   *
   * Asserted against the SOURCE because this script only runs behind a live
   * opt-in with real harness CLIs installed, so no CI job can exercise it.
   * Crude, but it fails against the old code, which is what a regression test
   * has to do.
   */
  it("hands Router an isolated BreakerStore, not the default one", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "smoke-agents.mjs"),
      "utf8",
    );
    const routerCall = /new Router\([^)]*\)/s.exec(src)?.[0] ?? "";
    expect(routerCall, "smoke script constructs Router").not.toBe("");
    expect(routerCall, "Router built without an explicit BreakerStore").toContain("BreakerStore");
    // And the store it builds must be a throwaway directory, never the default.
    expect(src).toMatch(/new BreakerStore\(\s*breakerDir\s*\)/);
    expect(src).toMatch(/mkdtemp\(/);
  });
});
