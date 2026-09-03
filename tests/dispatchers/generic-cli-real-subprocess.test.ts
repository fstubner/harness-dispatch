import { describe, it, expect } from "vitest";

import { GenericCliDispatcher } from "../../src/dispatchers/generic-cli.js";
import type { CliProtocolConfig, ServiceConfig } from "../../src/types.js";

// GenericCliDispatcher against a REAL child process, with nothing mocked.
//
// Every other dispatcher suite replaces `runSubprocess` with a vi.fn(), and
// `stream-subprocess.ts` carries a branch in PRODUCTION that detects that mock
// and synthesises one stdout chunk from the buffered result. So those suites
// prove how the dispatcher builds a command line and reads a finished blob —
// they cannot prove anything about the streaming path the dispatcher actually
// runs, because they never reach it.
//
// What that left unproven, and what this file covers:
//   - JSONL parsed across CHUNK BOUNDARIES. A mock hands over one perfect
//     blob; a real process splits wherever the pipe happens to flush, so a
//     line can arrive in two pieces and an event can straddle a read.
//   - A timeout that actually kills the child, rather than a mock returning
//     `timedOut: true` because the test said so.
//   - Abort propagating to a running process.
//   - stdout arriving as events DURING the run, not one lump at the end.
//
// `node -e` is the executable: always present wherever these tests run, and
// its output is whatever the script prints, so a case is a one-line script.

function nodeRoute(script: string, protocol: Partial<CliProtocolConfig> = {}): ServiceConfig {
  return {
    name: "stub",
    enabled: true,
    type: "cli",
    harness: "generic",
    command: process.execPath,
    tier: 1,
    weight: 1,
    cliCapability: 1,
    capabilities: {},
    escalateOn: [],
    protocol: {
      args: ["-e", script],
      output: { mode: "text" },
      ...protocol,
    },
  } as unknown as ServiceConfig;
}

describe("GenericCliDispatcher against a real process", () => {
  it("reads output from a process that prints and exits", async () => {
    const d = new GenericCliDispatcher(nodeRoute(`console.log("hello from the child")`));

    const res = await d.dispatch("ignored", [], process.cwd());

    expect(res.success, res.error).toBe(true);
    expect(res.output).toContain("hello from the child");
  });

  it("reassembles a JSONL event split across two writes", async () => {
    // The case a mocked buffered result can never produce: the dispatcher's
    // line reader has to hold a partial line across reads. Written as two
    // writes with a gap, so the pipe really does deliver them separately.
    const script = [
      `process.stdout.write('{"type":"item.completed","item":{"type":"agent_mess');`,
      `setTimeout(() => {`,
      `  process.stdout.write('age","text":"split across reads"}}\\n');`,
      `  process.exit(0);`,
      `}, 60);`,
    ].join("");
    const d = new GenericCliDispatcher(
      nodeRoute(script, {
        // The PARSED shape, not the YAML one: a ServiceConfig built by hand
        // skips the config loader that renames these.
        output: {
          mode: "jsonl_stream",
          eventRules: [
            {
              when: { type: "item.completed", "item.type": "agent_message" },
              emit: "text",
              textField: "item.text",
            },
          ],
        },
      } as unknown as Partial<CliProtocolConfig>),
    );

    const res = await d.dispatch("ignored", [], process.cwd());

    expect(res.success, res.error).toBe(true);
    expect(
      res.output,
      "a JSONL event split across two reads was not reassembled",
    ).toContain("split across reads");
  });

  it("kills a child that outlives its timeout, rather than waiting for it", async () => {
    // A mock returning `timedOut: true` proves the dispatcher can read a flag.
    // This proves the process is actually stopped: the script would run for a
    // minute, and the call has to come back long before that.
    const d = new GenericCliDispatcher(nodeRoute(`setTimeout(() => {}, 60_000)`));

    const started = Date.now();
    const res = await d.dispatch("ignored", [], process.cwd(), { timeoutMs: 400 });
    const elapsed = Date.now() - started;

    expect(res.success).toBe(false);
    expect(res.error ?? "", "the failure does not say it timed out").toMatch(/timed out/i);
    expect(elapsed, "the dispatcher waited for the child instead of killing it").toBeLessThan(
      20_000,
    );
  });

  it("stops a running child when the caller aborts", async () => {
    const controller = new AbortController();
    const d = new GenericCliDispatcher(nodeRoute(`setTimeout(() => {}, 60_000)`));

    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const res = await d.dispatch("ignored", [], process.cwd(), { signal: controller.signal });
    const elapsed = Date.now() - started;

    expect(res.success).toBe(false);
    expect(elapsed, "abort did not reach the child").toBeLessThan(20_000);
  });

  it("emits stdout as events while the child runs, not one lump at the end", async () => {
    // The property the whole streaming path exists for: partial output has to
    // be available before the process exits, which is what `job_status`
    // returns as `partialOutput`.
    const script = [
      `let i = 0;`,
      `const t = setInterval(() => {`,
      `  console.log("tick " + i);`,
      `  if (++i >= 3) { clearInterval(t); process.exit(0); }`,
      `}, 40);`,
    ].join("");
    const d = new GenericCliDispatcher(nodeRoute(script));

    const chunks: string[] = [];
    for await (const event of d.stream("ignored", [], process.cwd())) {
      if (event.type === "stdout") chunks.push(event.chunk);
    }

    expect(chunks.join("")).toContain("tick 0");
    expect(chunks.join("")).toContain("tick 2");
    // MORE THAN ONE event is the discriminator. "a chunk before completion"
    // is not: the buffered adapter also yields one chunk and then the end
    // event, so that assertion passed through the very path this test exists
    // to stay out of. Three writes 40ms apart cannot arrive as one read from
    // a live pipe, and can never arrive as more than one from the adapter.
    expect(
      chunks.length,
      "output arrived as a single lump — this ran through the buffered adapter, not the live stream",
    ).toBeGreaterThan(1);
  });
});
