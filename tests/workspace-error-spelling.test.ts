/**
 * The errors a dispatch caller gets back must use the caller's spelling.
 *
 * MCP and HTTP callers say `workspacePolicy`; `workspace_policy` is the
 * config.yaml spelling, and on MCP it is refused by name. Four messages told
 * the caller to "use workspace_policy: copy", so following the advice earned a
 * second error.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { prepareWorkspace } from "../src/workspaces.js";

describe("workspace precondition errors", () => {
  it("name workspacePolicy, not the config.yaml spelling", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-spelling-"));
    try {
      const err = await prepareWorkspace({
        routeName: "probe",
        policy: "git_worktree",
        workingDir: dir,
        files: [],
      }).then(
        () => undefined,
        (e: unknown) => (e as Error).message,
      );
      expect(err).toMatch(/workspacePolicy: copy/);
      expect(err).not.toMatch(/workspace_policy/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
