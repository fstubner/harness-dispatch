/**
 * The streaming path must deliver the ANSWER, not the harness's protocol.
 *
 * Tested here rather than through the HTTP server because the defect is only
 * visible in the DIFFERENCE between two event shapes, and a server-driven test
 * can produce just one of them per machine:
 *
 *  - an OpenAI-compatible upstream emits assistant text as stdout, so
 *    "forward everything" and "forward the answer" look identical — verified:
 *    reverting the fix left those tests green;
 *  - a CLI harness emits protocol, but which harnesses exist depends on the
 *    machine. A first attempt at a CLI-backed test silently dispatched to the
 *    real `claude_code_cli` instead of the fake route.
 *
 * As a function over an event sequence, both shapes are ordinary inputs.
 */

import { describe, expect, it } from "vitest";

import { createAnswerStream } from "../../src/http/answer-stream.js";
import type { DispatcherEvent } from "../../src/types.js";

const completion = (output: string, success = true): DispatcherEvent => ({
  type: "completion",
  result: { output, service: "r", success, ...(success ? {} : { error: "boom" }) },
});

/** Everything a client would concatenate into the visible message. */
function rendered(events: DispatcherEvent[]): string {
  const answer = createAnswerStream();
  return events.map((e) => answer(e) ?? "").join("");
}

describe("createAnswerStream", () => {
  it("sends the parsed answer for a harness that emits protocol on stdout", () => {
    // The exact shape an acceptance pass saw reaching delta.content.
    const out = rendered([
      { type: "stdout", chunk: '{"type":"thread.started","thread_id":"th_01"}\n' },
      { type: "stdout", chunk: '{"type":"turn.started"}\n' },
      { type: "stdout", chunk: '{"type":"item.completed","item":{"text":"pong"}}\n' },
      completion("pong"),
    ]);
    expect(out).toBe("pong");
    for (const leak of ["thread.started", "th_01", "turn.started", "item.completed"]) {
      expect(out, `protocol leaked into delta.content: ${leak}`).not.toContain(leak);
    }
  });

  it("streams an endpoint's text as it arrives, and does not repeat it at the end", () => {
    // An endpoint route marks its chunks as text: that IS the answer, and
    // showing it as it arrives is the point of streaming. Sending the parsed
    // output afterwards would deliver it twice.
    const out = rendered([
      { type: "stdout", chunk: "hel", text: true },
      { type: "stdout", chunk: "lo", text: true },
      completion("hello"),
    ]);
    expect(out).toBe("hello");
  });

  it("says nothing on a failed completion — the error frame carries that", () => {
    expect(rendered([completion("partial", false)])).toBe("");
  });

  it("ignores stderr, thinking and tool_use", () => {
    const out = rendered([
      { type: "stderr", chunk: "warning: something\n" },
      { type: "thinking", chunk: "considering..." },
      { type: "tool_use", name: "read_file", input: { path: "/etc/passwd" } },
      completion("done"),
    ]);
    expect(out).toBe("done");
  });

  it("emits nothing rather than an empty delta when there is no output", () => {
    const answer = createAnswerStream();
    expect(answer(completion(""))).toBeUndefined();
  });
});
