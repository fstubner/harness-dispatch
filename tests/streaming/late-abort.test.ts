/**
 * A cancel that arrives after the child has finished.
 *
 * One job signal is shared by every fallback attempt, and the abort listener
 * stayed attached after a run settled, so cancelling during a later attempt
 * signalled each earlier, finished child — whose pid may by then belong to an
 * unrelated process. Found in an audit.
 */
import { describe, expect, it, vi } from "vitest";

const killTree = vi.fn();
vi.mock("../../src/dispatchers/shared/kill-tree.js", () => ({ killTree }));

const { streamSubprocess } = await import("../../src/dispatchers/shared/stream-subprocess.js");

describe("a cancel after the run has ended", () => {
  it("signals nothing", async () => {
    const controller = new AbortController();
    for await (const _ of streamSubprocess(process.execPath, ["-e", "0"], { signal: controller.signal })) {
      // drain
    }
    controller.abort();
    expect(killTree).not.toHaveBeenCalled();
  });

  it("still stops a run that is going", async () => {
    const controller = new AbortController();
    const run = (async () => {
      for await (const _ of streamSubprocess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        signal: controller.signal,
        killGraceMs: 100,
      })) {
        // drain
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    expect(killTree).toHaveBeenCalled();
    // The mocked killTree cannot stop the child; let it finish on its own.
    await run;
  }, 15_000);
});
