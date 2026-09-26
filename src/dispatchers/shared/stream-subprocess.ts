/**
 * Streaming subprocess runner.
 *
 * Companion to `runSubprocess` — same spawn/kill/timeout semantics but emits
 * stdout and stderr chunks as the child writes them via an `AsyncIterable`.
 * A bounded internal queue protects against runaway processes flooding memory
 * (exceeding the bound kills the child).
 *
 * There is NO backpressure: nothing pauses the child's stdout, so a slow
 * consumer does not slow the producer — the queue grows instead, and past
 * `maxBufferedChunks` the child is killed and the iterator REJECTS, which in
 * the job runner marks a healthy run failed and discards its result.
 *
 * The iterator yields `{ stream, chunk }` tuples until the child exits,
 * whereupon it yields a single terminal `{ kind: "end", exitCode, timedOut,
 * durationMs }` event before signalling completion to the consumer.
 *
 * Cancellation: calling `.return()` on the iterator (which `for await ... of`
 * does automatically when you `break` or throw) sends SIGTERM to the child
 * and drains any remaining buffered chunks. If the child doesn't exit within
 * a grace window, SIGKILL is sent.
 */
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import spawn from "cross-spawn";
import { killTree } from "./kill-tree.js";

export interface SubprocessChunk {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface SubprocessEnd {
  kind: "end";
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  totalStdoutBytes: number;
  totalStderrBytes: number;
  truncated: boolean;
}

export type SubprocessStreamEvent = SubprocessChunk | SubprocessEnd;

export interface StreamSubprocessOpts {
  /**
   * Abort the run and kill the child (and its process group) on demand.
   *
   * This is the ONLY reliable way to stop a silent child. Calling return() on
   * the iterator does not work when the consumer is an async generator
   * suspended at an `await`: the return lands after that await settles, which
   * for an agent CLI that has gone quiet is never. Cancellation therefore has
   * to reach terminateChild directly rather than travelling back up the
   * iterator chain.
   */
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Maximum number of chunks to buffer internally before the child is
   * considered runaway and killed. Defaults to 1000.
   */
  maxBufferedChunks?: number;
  /**
   * Graceful-kill window before SIGKILL is sent. Defaults to 2s — matches
   * `runSubprocess`.
   */
  killGraceMs?: number;
  /**
   * How long output may keep arriving after the child has exited before its
   * pipes are closed from this side. Defaults to 2s.
   */
  exitDrainMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_CHUNKS = 1000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_EXIT_DRAIN_MS = 2_000;

/**
 * Stream a subprocess's stdout/stderr as an AsyncIterable.
 *
 * Completion is signalled by yielding a terminal `kind: "end"` event, after
 * which the iterator closes.
 */
export function streamSubprocess(
  command: string,
  args: readonly string[],
  opts: StreamSubprocessOpts = {},
): AsyncIterable<SubprocessStreamEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxBufferedChunks = opts.maxBufferedChunks ?? DEFAULT_MAX_BUFFERED_CHUNKS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const exitDrainMs = opts.exitDrainMs ?? DEFAULT_EXIT_DRAIN_MS;

  const start = Date.now();

  type Waiter = {
    resolve: (v: IteratorResult<SubprocessStreamEvent>) => void;
    reject: (err: unknown) => void;
  };

  const queue: SubprocessStreamEvent[] = [];
  const waiters: Waiter[] = [];
  let done = false;
  let errored: unknown = null;
  let child: ChildProcess | null = null;

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;
  let settled = false;
  let exited = false;

  function push(evt: SubprocessStreamEvent): void {
    if (done) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ value: evt, done: false });
    } else {
      queue.push(evt);
      if (queue.length > maxBufferedChunks) {
        errored = new Error(
          `stream-subprocess: internal queue exceeded ${maxBufferedChunks} chunks — consumer not draining`,
        );
        truncated = true;
        terminateChild("SIGTERM");
      }
    }
  }

  // One decoder per stream, held across chunks.
  //
  // Decoding each `data` buffer on its own turns any multi-byte character
  // straddling two reads into replacement characters, corrupting accented
  // text, CJK, emoji and box-drawing in everything this path feeds —
  // partialOutput, stdout.log, result.md. StringDecoder holds an incomplete
  // sequence back until the bytes that finish it arrive; `end()` at teardown
  // flushes whatever never completed.
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  function finish(): void {
    // Flush whatever the decoders were holding back.
    //
    // A StringDecoder withholds an incomplete multi-byte sequence until the
    // bytes completing it arrive. If the child exits mid-character — a
    // truncated run, a kill, a crash partway through a write — those bytes
    // would otherwise be dropped silently. `end()` returns them as replacement
    // characters: visibly wrong beats invisibly absent.
    const tailOut = stdoutDecoder.end();
    if (tailOut !== "") push({ stream: "stdout", chunk: tailOut });
    const tailErr = stderrDecoder.end();
    if (tailErr !== "") push({ stream: "stderr", chunk: tailErr });
    done = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (!w) break;
      if (errored) w.reject(errored);
      else w.resolve({ value: undefined, done: true });
    }
  }

  function terminateChild(sig: NodeJS.Signals): void {
    // A settled child is gone and its pid may already belong to something
    // else. One job signal is shared by every fallback attempt, so a cancel
    // during a later attempt reached this for each earlier, finished one.
    if (!child || settled) return;
    killTree(child, sig);
    setTimeout(() => {
      if (!settled && child) killTree(child, "SIGKILL");
    }, killGraceMs).unref();
  }

  const spawnOpts: SpawnOptions = {
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
    // POSIX: own process group, so killTree can signal the agent CLI's whole
    // tree (its shells, its test runners) rather than only the CLI itself.
    // Windows keeps the default — taskkill /T handles the tree there, and
    // `detached` on Windows means a new console instead.
    detached: process.platform !== "win32",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  };
  if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;

  try {
    child = spawn(command, args as readonly string[] as string[], spawnOpts);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    errored = e;
    queueMicrotask(finish);
    return buildIterable();
  }
  if (opts.stdin !== undefined) {
    // A child that exits without reading its stdin makes this write fail
    // (EPIPE; `write EOF` on Windows) once the prompt is bigger than the pipe
    // buffer. With no listener, Node raises that as an uncaught `error` event
    // and the WHOLE process dies — the supervisor and every job it holds, or
    // the HTTP server. The failed write needs no handling of its own: the
    // child's exit is what ends the run, and its exit code and output already
    // say what happened.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.stdin);
  }

  const timer = setTimeout(() => {
    // An exited child has finished; the drain below settles it.
    if (settled || exited) return;
    timedOut = true;
    terminateChild("SIGTERM");
  }, timeoutMs);
  timer.unref();

  if (opts.signal) {
    if (opts.signal.aborted) terminateChild("SIGTERM");
    else opts.signal.addEventListener("abort", () => terminateChild("SIGTERM"), { once: true });
  }

  child.stdout?.on("data", (buf: Buffer) => {
    if (truncated) return;
    if (stdoutBytes + buf.length > maxOutputBytes) {
      const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
      if (remaining > 0) {
        push({ stream: "stdout", chunk: stdoutDecoder.write(buf.subarray(0, remaining)) });
      }
      stdoutBytes = maxOutputBytes;
      truncated = true;
      terminateChild("SIGTERM");
      return;
    }
    stdoutBytes += buf.length;
    push({ stream: "stdout", chunk: stdoutDecoder.write(buf) });
  });

  child.stderr?.on("data", (buf: Buffer) => {
    if (truncated) return;
    if (stderrBytes + buf.length > maxOutputBytes) {
      const remaining = Math.max(0, maxOutputBytes - stderrBytes);
      if (remaining > 0) {
        push({ stream: "stderr", chunk: stderrDecoder.write(buf.subarray(0, remaining)) });
      }
      stderrBytes = maxOutputBytes;
      truncated = true;
      terminateChild("SIGTERM");
      return;
    }
    stderrBytes += buf.length;
    push({ stream: "stderr", chunk: stderrDecoder.write(buf) });
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    errored = err;
    finish();
  });

  // `close` waits for the child's stdio pipes as well as the child, and a
  // descendant that inherited them — a dev server or build daemon the agent
  // left running — holds them open after the agent has exited. On POSIX that
  // kept a finished run open until the timer fired, and the run was recorded
  // as timed out. So once the child has exited, give its last output a moment
  // to arrive, then close the pipes from this side; `close` follows with the
  // child's own exit code.
  child.on("exit", () => {
    exited = true;
    setTimeout(() => {
      if (settled) return;
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }, exitDrainMs).unref();
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const exitCode = code ?? (signal ? 128 : -1);
    push({
      kind: "end",
      exitCode,
      timedOut,
      durationMs: Date.now() - start,
      totalStdoutBytes: stdoutBytes,
      totalStderrBytes: stderrBytes,
      truncated,
    });
    finish();
  });

  // The three iterator methods, named rather than written inline: none uses
  // `this`, so keeping them here avoids nesting buildIterable several
  // object/function literals deep.

  /** Next buffered event, the terminal state, or a promise a writer resolves. */
  function nextEvent(): Promise<IteratorResult<SubprocessStreamEvent>> {
    if (queue.length > 0) {
      const evt = queue.shift()!;
      return Promise.resolve({ value: evt, done: false });
    }
    if (done) {
      if (errored) return Promise.reject(errored);
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  /**
   * Consumer abandoned the stream (a `break` in a for-await). Kill the child
   * and release every waiter — leaving one pending would hang the caller.
   */
  function stopIteration(): Promise<IteratorResult<SubprocessStreamEvent>> {
    if (!settled) terminateChild("SIGTERM");
    done = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w.resolve({ value: undefined, done: true });
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  /** Consumer threw into the stream: same teardown, propagate the error. */
  function failIteration(err?: unknown): Promise<IteratorResult<SubprocessStreamEvent>> {
    if (!settled) terminateChild("SIGTERM");
    done = true;
    return Promise.reject(err);
  }

  function buildIterable(): AsyncIterable<SubprocessStreamEvent> {
    // A fresh iterator object per call, but they share the one queue, so this
    // stream is single-consumer.
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<SubprocessStreamEvent> => ({
        next: nextEvent,
        return: stopIteration,
        throw: failIteration,
      }),
    };
  }

  return buildIterable();
}

/**
 * Convenience: drain a `streamSubprocess` iterable into a `SubprocessResult`
 * (same shape as `runSubprocess`) by buffering every chunk. Used by the
 * dispatchers' legacy `dispatch()` wrappers.
 */
export interface DrainedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export async function drainSubprocessStream(
  iter: AsyncIterable<SubprocessStreamEvent>,
): Promise<DrainedResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = -1;
  let durationMs = 0;
  let timedOut = false;
  let truncated = false;
  for await (const evt of iter) {
    if ("stream" in evt) {
      if (evt.stream === "stdout") stdout.push(evt.chunk);
      else stderr.push(evt.chunk);
    } else {
      exitCode = evt.exitCode;
      durationMs = evt.durationMs;
      timedOut = evt.timedOut;
      truncated = evt.truncated;
    }
  }
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode,
    durationMs,
    timedOut,
    truncated,
  };
}
