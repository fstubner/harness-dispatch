/**
 * A job that finishes before the watcher reads anything still sends its output
 * as progress.
 *
 * The watcher tails stdout.partial.log every ~300 ms, but a successful run
 * deletes that log when it finishes. A job that wrote two lines and exited
 * inside one tick was never opened, so its lines reached the caller only in
 * the final result. Measured end to end on the real server: a run printing two
 * short lines sent 0 progress notifications in 8 of 10 dispatches.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { watchUntilTerminal } from "../src/jobs/run.js";
import { clearActiveSecrets, setActiveSecrets } from "../src/redaction.js";
import type { DispatcherEvent, RouterConfig } from "../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-short-progress-"));
  await fs.mkdir(path.join(tmpDir, "output"), { recursive: true });
});

afterEach(async () => {
  clearActiveSecrets();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function plantStatus(status: "completed" | "failed"): Promise<void> {
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(tmpDir, "status.json"),
    JSON.stringify({ jobId: "job-1700000000900-aaaaaaaa", status, createdAt: now, updatedAt: now, jobDir: tmpDir }),
    "utf8",
  );
}

async function watched(): Promise<string> {
  const events: DispatcherEvent[] = [];
  await watchUntilTerminal(tmpDir, { onEvent: (e) => events.push(e) });
  return events.map((e) => (e.type === "stdout" ? e.chunk : "")).join("");
}

describe("progress for a job that finished before the watcher looked", () => {
  it("relays the run's output from stdout.log", async () => {
    // What a finished successful run leaves: no partial log, the answer in stdout.log.
    await fs.writeFile(path.join(tmpDir, "output", "stdout.log"), "alpha one\nbeta two", "utf8");
    await plantStatus("completed");
    expect(await watched()).toBe("alpha one\nbeta two");
  });

  it("does not repeat output the partial log already relayed", async () => {
    await fs.writeFile(path.join(tmpDir, "output", "stdout.partial.log"), "alpha one\nbeta two\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "output", "stdout.log"), "alpha one\nbeta two", "utf8");
    await plantStatus("failed");
    expect(await watched()).toBe("alpha one\nbeta two\n");
  });

  it("sends nothing for a run with no output", async () => {
    await fs.writeFile(path.join(tmpDir, "output", "stdout.log"), "", "utf8");
    await plantStatus("failed");
    expect(await watched()).toBe("");
  });

  it("never sends a configured key, even one a result file holds in the clear", async () => {
    const key = "sk-hdtest-SHORTJOB-0123456789abcdef";
    setActiveSecrets({ services: { keyed: { apiKey: key } } } as unknown as RouterConfig);
    await fs.writeFile(path.join(tmpDir, "output", "stdout.log"), `token ${key} end`, "utf8");
    await plantStatus("completed");
    const sent = await watched();
    expect(sent).toContain("token");
    expect(sent).not.toContain(key);
  });
});
