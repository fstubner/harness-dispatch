import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildDispatchLogEntry, dispatchLogPath, logDispatch } from "../src/dispatch-log.js";
import type { DispatchResult, RoutingDecision } from "../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-dispatch-log-"));
  vi.stubEnv("HARNESS_DISPATCH_LOG_DIR", tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function result(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return { output: "hello", service: "my_route", success: true, durationMs: 123, ...overrides };
}

// logDispatch is synchronous by design (see dispatch-log.ts) — the line is
// on disk the moment the call returns, even if the process exits next tick.

describe("dispatch log", () => {
  it("appends one JSONL entry per dispatch with route/result/decision fields", async () => {
    const decision = {
      service: "my_route",
      tier: 1,
      taskType: "review",
      model: "some-model",
      effectiveSafetyProfile: "read_only",
      reason: "explicit",
      finalScore: 1,
    } as unknown as RoutingDecision;

    logDispatch("my_route", result(), decision);
    const text = await fs.readFile(dispatchLogPath(), "utf8");
    const entry = JSON.parse(text.trim().split("\n")[0]!);

    expect(entry.route).toBe("my_route");
    expect(entry.success).toBe(true);
    expect(entry.durationMs).toBe(123);
    expect(entry.outputChars).toBe(5);
    expect(entry.taskType).toBe("review");
    expect(entry.model).toBe("some-model");
    expect(entry.safetyProfile).toBe("read_only");
    expect(typeof entry.ts).toBe("string");
  });

  it("records what the picked route beat, so the log can answer whether the router chose well", () => {
    // `reason` records that a choice happened ("tier 1 best (3 available)")
    // and never what it was between. A month of real logs could therefore say
    // the router had been used and not whether it was any good — which is the
    // exact analysis routing.candidates was added to the response for, and it
    // could not be run from the log that justified adding it.
    const decision = {
      service: "picked",
      tier: 1,
      reason: "tier 1 best (3 available)",
      finalScore: 0.92,
      candidates: [
        { route: "picked", score: 0.92 },
        { route: "runner_up", score: 0.81 },
      ],
    } as unknown as RoutingDecision;

    const entry = buildDispatchLogEntry("picked", result(), decision);
    expect(entry.candidates).toEqual([
      { route: "picked", score: 0.92 },
      { route: "runner_up", score: 0.81 },
    ]);
  });

  it("omits candidates when nothing was compared", () => {
    // Forced and explicit dispatches were not chosen over anything. An empty
    // or one-entry list in the log would imply a comparison that never
    // happened, and this file is the input to that analysis.
    const forced = {
      service: "only",
      tier: 1,
      reason: "explicit",
      finalScore: 1,
    } as unknown as RoutingDecision;
    expect(buildDispatchLogEntry("only", result(), forced).candidates).toBeUndefined();
    expect(buildDispatchLogEntry("only", result()).candidates).toBeUndefined();
  });

  it("records failures with a capped error string and rateLimited flag", () => {
    const entry = buildDispatchLogEntry(
      "sad_route",
      result({ success: false, rateLimited: true, error: "x".repeat(1000), output: "" }),
    );
    expect(entry.success).toBe(false);
    expect(entry.rateLimited).toBe(true);
    expect(entry.error!.length).toBe(300);
    expect(entry.outputChars).toBeUndefined();
  });

  it("never throws into the dispatch path when the log dir is unwritable", () => {
    vi.stubEnv("HARNESS_DISPATCH_LOG_DIR", path.join(tmpDir, "nope\0bad"));
    expect(() => logDispatch("r", result())).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "creates the log file and its directory as owner-only (0600/0700), not world-readable",
    async () => {
      logDispatch("my_route", result());
      const fileMode = (await fs.stat(dispatchLogPath())).mode & 0o777;
      const dirMode = (await fs.stat(path.dirname(dispatchLogPath()))).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    },
  );
});
