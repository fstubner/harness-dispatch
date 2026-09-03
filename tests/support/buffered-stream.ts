/**
 * Drive a `streamSubprocess` mock from a buffered `runSubprocess`-shaped one.
 *
 * This logic used to live in `src/dispatchers/shared/stream-subprocess.ts`,
 * where the exported function inspected `runSubprocess` for vitest's `.mock`
 * property and, if it found one, took a completely different code path. That
 * meant the production module carried a branch that only ever executed under
 * test — and, worse, that every dispatcher suite exercised the adapter rather
 * than the streaming implementation the dispatchers actually run. A streaming
 * bug could not be caught by the tests that mocked around it.
 *
 * Moving it here changes nothing about what the suites assert: they still set
 * up a buffered result and still read their argv/env/stdin expectations off
 * the same recording mock. The difference is that the seam is now declared by
 * the test rather than sniffed for by the code under test.
 *
 * The event ordering — stdout, then stderr, then `end` — matches what a real
 * child emits when it flushes both pipes before exit. Suites that need chunks
 * interleaved, or more than one chunk per stream, should mock
 * `streamSubprocess` directly and yield the events they want; that is what
 * `tests/dispatchers/antigravity.test.ts` does.
 */

import type { SubprocessResult } from "../../src/dispatchers/shared/subprocess.js";
import type {
  StreamSubprocessOpts,
  SubprocessStreamEvent,
} from "../../src/dispatchers/shared/stream-subprocess.js";

/** The buffered call signature `run` is required to have. */
export type BufferedRun = (
  command: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => Promise<SubprocessResult> | SubprocessResult;

/**
 * Build a `streamSubprocess` implementation backed by `run`, which must have
 * the `BufferedRun` shape.
 *
 * Typed `unknown` rather than `BufferedRun` because the suites hold their
 * mocks as `ReturnType<typeof vi.fn>` — a UNION of call and construct
 * signatures, which is assignable to neither a precise signature nor a
 * widened one. The cast has to happen somewhere; once here reads better than
 * six times at the call sites.
 *
 * Only the options `runSubprocess` understands are forwarded, so a suite that
 * asserts on the third argument sees the same object shape it saw before this
 * moved out of production code.
 */
export function streamFromBuffered(run: unknown) {
  const call = run as BufferedRun;
  return function streamSubprocessStub(
    command: string,
    args: readonly string[],
    opts: StreamSubprocessOpts = {},
  ): AsyncIterable<SubprocessStreamEvent> {
    const forwarded: Record<string, unknown> = {};
    if (opts.cwd !== undefined) forwarded.cwd = opts.cwd;
    if (opts.env !== undefined) forwarded.env = opts.env;
    if (opts.stdin !== undefined) forwarded.stdin = opts.stdin;
    if (opts.timeoutMs !== undefined) forwarded.timeoutMs = opts.timeoutMs;
    if (opts.maxOutputBytes !== undefined)
      forwarded.maxOutputBytes = opts.maxOutputBytes;

    async function* gen(): AsyncGenerator<SubprocessStreamEvent> {
      const res = await call(command, args, forwarded);
      if (res.stdout) yield { stream: "stdout", chunk: res.stdout };
      if (res.stderr) yield { stream: "stderr", chunk: res.stderr };
      yield {
        kind: "end",
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        totalStdoutBytes: Buffer.byteLength(res.stdout, "utf8"),
        totalStderrBytes: Buffer.byteLength(res.stderr, "utf8"),
        truncated: false,
      };
    }
    return gen();
  };
}
