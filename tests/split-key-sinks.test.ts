/**
 * A configured key that a route prints split across two writes must not reach
 * ANY sink whole.
 *
 * Per-chunk redaction cannot see a key whose first half ends one chunk and
 * second half starts the next: each half is scrubbed on its own, finds nothing,
 * and the reader of the sink joins them back into the key. The partial log
 * already held a tail across chunks; the job events log (what a streaming
 * caller replays) and MCP progress notifications did not.
 *
 * Driven end to end: real routes (a CLI child process, and an endpoint served
 * by a local fake), each writing with a gap between the halves so they arrive
 * separately, the real router, and the MCP dispatch handler with a progress
 * token. Each sink is read the way its consumer reads it — chunks joined — and
 * must not contain the key.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapRuntime, RuntimeHolder } from "../src/mcp/config-hot-reload.js";
import { handleDispatch } from "../src/mcp/tools.js";
import { clearActiveSecrets } from "../src/redaction.js";
import type { DispatcherEvent } from "../src/types.js";

// Synthetic, test-only.
const KEY = "sk-hdtest-SPLITKEY-0123456789abcdef";
const HEAD = KEY.slice(0, 14);
const TAIL = KEY.slice(14);

let tmpDir: string;
let logDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-splitkey-"));
  logDir = path.join(tmpDir, "logs");
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", path.join(tmpDir, "jobs"));
  vi.stubEnv("HARNESS_DISPATCH_LOG_DIR", logDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  clearActiveSecrets();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function chunksOf(events: DispatcherEvent[], type: "stdout" | "stderr"): string {
  return events
    .filter((e): e is Extract<DispatcherEvent, { type: typeof type }> => e.type === type)
    .map((e) => e.chunk)
    .join("");
}

/** Dispatch through the MCP handler and read back every sink. */
async function dispatchAndReadSinks(configYaml: string, service: string): Promise<Record<string, string>> {
  const configPath = path.join(tmpDir, "config.yaml");
  await fs.writeFile(configPath, configYaml, "utf8");
  const holder = new RuntimeHolder(await bootstrapRuntime({ configPath }));

  const progress: DispatcherEvent[] = [];
  const response = (await handleDispatch(
    { holder },
    { prompt: "go", mode: "single", service, workingDir: tmpDir, hints: { taskType: "plan" }, graceSeconds: 30 },
    {
      _meta: { progressToken: "p" },
      sendNotification: async (n) => {
        const event = (n.params as { _meta?: { event?: DispatcherEvent } })._meta?.event;
        if (event !== undefined) progress.push(event);
      },
    },
  )) as { completed: boolean };
  expect(response.completed).toBe(true);
  // Progress notifications are sent without being awaited; let them land.
  await new Promise((r) => setTimeout(r, 200));

  const jobsRoot = path.join(tmpDir, "jobs");
  const [jobId] = await fs.readdir(jobsRoot);
  const output = path.join(jobsRoot, jobId!, "output");
  const read = (file: string): Promise<string> => fs.readFile(file, "utf8").catch(() => "");
  const logged = (await read(path.join(output, "events.jsonl")))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as DispatcherEvent);

  return {
    "events log (answer text joined)": chunksOf(logged, "stdout"),
    "partial log": await read(path.join(output, "stdout.partial.log")),
    "progress (stdout chunks joined)": chunksOf(progress, "stdout"),
    "progress (stderr chunks joined)": chunksOf(progress, "stderr"),
    "result.json": await read(path.join(output, "result.json")),
    "stdout.log": await read(path.join(output, "stdout.log")),
    "dispatch log": await read(path.join(logDir, "dispatches.jsonl")),
  };
}

function leakedIn(sinks: Record<string, string>): string[] {
  return Object.entries(sinks)
    .filter(([, text]) => text.includes(KEY))
    .map(([name]) => name);
}

describe("a key printed in two halves", () => {
  it("by a CLI route, cut inside one line, is whole in no sink", async () => {
    // One output line written in two halves with the cut inside the key: two
    // raw stdout chunks. Exits 1, because a failed job keeps its partial log,
    // which is the copy read here.
    const harness = path.join(tmpDir, "harness.cjs");
    await fs.writeFile(
      harness,
      [
        `process.stdout.write(${JSON.stringify(`rejected key ${HEAD}`)});`,
        "setTimeout(() => {",
        `  process.stdout.write(${JSON.stringify(`${TAIL} end\n`)});`,
        "  setTimeout(() => process.exit(1), 100);",
        "}, 300);",
      ].join("\n"),
      "utf8",
    );
    const sinks = await dispatchAndReadSinks(
      [
        "clis:",
        "  - name: keyed_node",
        "    harness: generic",
        `    command: ${JSON.stringify(process.execPath)}`,
        `    api_key: ${KEY}`,
        "    tier: 3",
        "    billing_kind: local_compute",
        "    paid_usage_possible: false",
        "    protocol:",
        `      args: [${JSON.stringify(harness)}, "{{prompt}}"]`,
        "      output: { mode: text }",
      ].join("\n"),
      "keyed_node",
    );
    // The output under test really reached the sinks that record raw output;
    // an empty sink would pass the leak check vacuously.
    expect(sinks["partial log"]).toContain(" end");
    expect(sinks["progress (stdout chunks joined)"]).toContain(" end");

    expect(leakedIn(sinks), "sinks holding the whole key").toEqual([]);
  }, 30_000);

  it("by an endpoint, across two streamed answer deltas, is whole in no sink", async () => {
    // Answer text is what the events log records, and only an endpoint streams
    // it: two SSE deltas with a gap, the key cut between them.
    const delta = (content: string): string =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(delta(`rejected key ${HEAD}`));
        setTimeout(() => {
          res.write(delta(`${TAIL} end`));
          res.end("data: [DONE]\n\n");
        }, 300);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const sinks = await dispatchAndReadSinks(
        [
          "services:",
          "  keyed_endpoint:",
          "    enabled: true",
          "    type: openai_compatible",
          `    base_url: http://127.0.0.1:${port}/v1`,
          `    api_key: ${KEY}`,
          "    model: local-test",
          "    provider: local",
          "    surface: local_endpoint",
          "    billing_kind: local_compute",
          "    paid_usage_possible: false",
          "    billing_confidence: documented",
          "    tier: 3",
        ].join("\n"),
        "keyed_endpoint",
      );
      expect(sinks["events log (answer text joined)"]).toContain(" end");
      expect(sinks["progress (stdout chunks joined)"]).toContain(" end");

      expect(leakedIn(sinks), "sinks holding the whole key").toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 30_000);
});
