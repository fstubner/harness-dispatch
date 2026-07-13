import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildShortTaskPrompt,
  buildTaskBrief,
  smokeWorkspaceRoot,
} from "../scripts/smoke-agents.mjs";

describe("live agent smoke task brief", () => {
  it("keeps the routed prompt short and puts detailed instructions in the workspace brief", () => {
    const briefPath = "C:\\tmp\\fixture\\.harness-router\\agent-task.md";
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
    const previous = process.env.HARNESS_ROUTER_AGENT_SMOKE_ROOT;
    delete process.env.HARNESS_ROUTER_AGENT_SMOKE_ROOT;
    try {
      const root = smokeWorkspaceRoot(process.cwd());
      expect(path.isAbsolute(root)).toBe(true);
      expect(root.endsWith(path.join(".harness-router", "smoke-workspaces"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HARNESS_ROUTER_AGENT_SMOKE_ROOT;
      else process.env.HARNESS_ROUTER_AGENT_SMOKE_ROOT = previous;
    }
  });
});
