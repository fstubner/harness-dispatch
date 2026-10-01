/**
 * Two workspace actions on one job inside ONE server.
 *
 * The lock's timeout only bounded the wait on another process; inside the
 * same server the second action queued on a promise with no deadline, so the
 * "still running after 120s" error never fired and it waited as long as the
 * first took.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquireJobActionLock } from "../src/jobs/lifecycle.js";
import { acquireWorkspaceLock } from "../src/workspace-lock.js";

describe("the per-job action lock", () => {
  it("gives up on schedule when the holder is in the same process", async () => {
    const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-action-lock-"));
    const release = await acquireWorkspaceLock(jobDir, 5_000);
    try {
      const t0 = Date.now();
      const outcome = await Promise.race([
        acquireJobActionLock(jobDir, 300).then(
          () => "acquired",
          () => "timed out",
        ),
        new Promise((r) => setTimeout(() => r("still waiting"), 3_000)),
      ]);
      expect(outcome).toBe("timed out");
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      release();
    }
    // The abandoned acquisition let go as soon as it landed: a fresh one is
    // not stuck behind it.
    const again = await acquireJobActionLock(jobDir, 2_000);
    again();
    await fs.rm(jobDir, { recursive: true, force: true });
  });
});
