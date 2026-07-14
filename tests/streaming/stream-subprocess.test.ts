/**
 * Unit tests for `streamSubprocess` + `drainSubprocessStream`.
 *
 * Uses a real `node -e "..."` child for end-to-end verification — this is
 * the only place where we spawn real processes. Tests are hermetic because
 * the launched scripts complete in <100ms.
 */

import { describe, it, expect } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { streamSubprocess, drainSubprocessStream } from "../../src/dispatchers/shared/stream-subprocess.js";

const NODE = process.execPath;
const execFileAsync = promisify(execFileCb);

describe("streamSubprocess", () => {
  it("yields stdout chunks in order and emits a terminal end event", async () => {
    const script = `
      process.stdout.write('a');
      process.stdout.write('b');
      process.stdout.write('c');
    `;
    const events: Array<{ kind: string; chunk?: string; exitCode?: number }> = [];
    for await (const evt of streamSubprocess(NODE, ["-e", script])) {
      if ("stream" in evt) {
        events.push({ kind: evt.stream, chunk: evt.chunk });
      } else {
        events.push({ kind: "end", exitCode: evt.exitCode });
      }
    }
    // stdout chunks may coalesce — require concatenation equals expected.
    const stdoutText = events
      .filter((e) => e.kind === "stdout")
      .map((e) => e.chunk ?? "")
      .join("");
    expect(stdoutText).toBe("abc");
    expect(events[events.length - 1]?.kind).toBe("end");
    expect(events[events.length - 1]?.exitCode).toBe(0);
  });

  it("separately captures stderr", async () => {
    const script = `
      process.stderr.write('err-chunk');
      process.stdout.write('out-chunk');
    `;
    const stdout: string[] = [];
    const stderr: string[] = [];
    for await (const evt of streamSubprocess(NODE, ["-e", script])) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") stdout.push(evt.chunk);
        else stderr.push(evt.chunk);
      }
    }
    expect(stdout.join("")).toBe("out-chunk");
    expect(stderr.join("")).toBe("err-chunk");
  });

  it("respects timeoutMs and terminates the child", async () => {
    const script = `
      // Sleep indefinitely so the timeout must fire.
      setInterval(() => {}, 10_000);
    `;
    const events: unknown[] = [];
    for await (const evt of streamSubprocess(NODE, ["-e", script], { timeoutMs: 200 })) {
      events.push(evt);
    }
    const terminal = events[events.length - 1] as {
      kind: string;
      timedOut: boolean;
    };
    expect(terminal.kind).toBe("end");
    expect(terminal.timedOut).toBe(true);
  }, 5_000);

  it("respects maxOutputBytes and truncates+kills the child", async () => {
    const script = `
      const buf = 'x'.repeat(1024);
      setInterval(() => process.stdout.write(buf), 5);
    `;
    let totalBytes = 0;
    for await (const evt of streamSubprocess(NODE, ["-e", script], {
      maxOutputBytes: 4096,
      timeoutMs: 5_000,
    })) {
      if ("stream" in evt) totalBytes += evt.chunk.length;
      else {
        expect(evt.truncated).toBe(true);
        break;
      }
    }
    // We yielded at most maxOutputBytes; may be slightly less due to chunking.
    expect(totalBytes).toBeLessThanOrEqual(4096);
  }, 10_000);

  it("closes the iterator when the consumer breaks early", async () => {
    const script = `
      let i = 0;
      const t = setInterval(() => {
        process.stdout.write('tick ' + (++i) + '\\n');
        if (i > 100) { clearInterval(t); process.exit(0); }
      }, 10);
    `;
    let count = 0;
    for await (const evt of streamSubprocess(NODE, ["-e", script], { timeoutMs: 5_000 })) {
      if ("stream" in evt) {
        count += 1;
        if (count >= 2) break; // early cancellation
      }
    }
    expect(count).toBeGreaterThanOrEqual(1);
    // If we reach this line, .return() worked and the subprocess was killed.
  }, 10_000);

  it("reports a non-zero exit code in the terminal event", async () => {
    const script = `process.exit(7);`;
    let terminal: { exitCode: number } | null = null;
    for await (const evt of streamSubprocess(NODE, ["-e", script])) {
      if (!("stream" in evt)) terminal = { exitCode: evt.exitCode };
    }
    expect(terminal?.exitCode).toBe(7);
  });

  it("writes stdin to the child when provided", async () => {
    const script = `
      process.stdin.setEncoding('utf8');
      let input = '';
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => process.stdout.write(input.toUpperCase()));
    `;
    const res = await drainSubprocessStream(
      streamSubprocess(NODE, ["-e", script], { stdin: "agent brief" }),
    );
    expect(res.stdout).toBe("AGENT BRIEF");
    expect(res.exitCode).toBe(0);
  });

  it("yields chunks in real time (not all at the end)", async () => {
    // Slow producer: writes one chunk every 80ms. If streamSubprocess were
    // buffering until EOF, the observed timestamps would all bunch at the
    // end. Instead we expect at least two chunks with significant time gaps.
    const script = `
      let i = 0;
      const t = setInterval(() => {
        process.stdout.write('tick ' + (++i) + '\\n');
        if (i >= 4) { clearInterval(t); process.exit(0); }
      }, 80);
    `;
    const chunkTimestamps: number[] = [];
    const start = Date.now();
    for await (const evt of streamSubprocess(NODE, ["-e", script], { timeoutMs: 5_000 })) {
      if ("stream" in evt && evt.stream === "stdout") {
        chunkTimestamps.push(Date.now() - start);
      }
    }
    expect(chunkTimestamps.length).toBeGreaterThanOrEqual(2);
    // Between the first and the last chunk we should see > 100ms of wall
    // time — confirming real-time delivery (not all-at-once buffering).
    const first = chunkTimestamps[0]!;
    const last = chunkTimestamps[chunkTimestamps.length - 1]!;
    expect(last - first).toBeGreaterThan(100);
  }, 10_000);

  it.skipIf(process.platform !== "win32")(
    "kills the grandchild process when the direct child is a cmd.exe wrapper",
    async () => {
      // Reproduces exactly what windows-cmd.ts's `cmd /c <path>` fallback
      // does: cmd.exe is the DIRECT child, and it spawns the real long-running
      // process as ITS OWN child (a grandchild of this test process).
      // child.kill() only ever signalled the direct child (cmd.exe); on
      // timeout the real process was left running indefinitely.
      const markerFile = path.join(
        os.tmpdir(),
        `hr-grandchild-pid-${randomUUID()}.txt`,
      );
      const grandchildScript =
        `require('fs').writeFileSync(${JSON.stringify(markerFile)}, String(process.pid));` +
        `setInterval(() => {}, 10_000);`;

      for await (const _evt of streamSubprocess(
        "cmd",
        ["/c", NODE, "-e", grandchildScript],
        { timeoutMs: 800 },
      )) {
        // drain
      }

      let grandchildPid: number | undefined;
      for (let i = 0; i < 40; i += 1) {
        if (existsSync(markerFile)) {
          grandchildPid = Number(readFileSync(markerFile, "utf8"));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(grandchildPid).toBeDefined();

      // taskkill runs async (fire-and-forget) — give it a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const { stdout } = await execFileAsync("tasklist", [
        "/FI",
        `PID eq ${grandchildPid}`,
      ]);
      expect(stdout).not.toContain(String(grandchildPid));

      rmSync(markerFile, { force: true });
    },
    15_000,
  );
});

describe("drainSubprocessStream", () => {
  it("buffers the stream into a SubprocessResult-like object", async () => {
    const script = `
      process.stdout.write('hello');
      process.stderr.write('world');
      process.exit(3);
    `;
    const res = await drainSubprocessStream(streamSubprocess(NODE, ["-e", script]));
    expect(res.stdout).toBe("hello");
    expect(res.stderr).toBe("world");
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });
});
