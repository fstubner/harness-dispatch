/**
 * What a streaming HTTP client should be shown, from what a dispatcher emits.
 *
 * WHY THIS IS A SEPARATE FUNCTION. The streaming branch forwarded every stdout
 * chunk into `delta.content`. For an OpenAI-compatible endpoint that is
 * correct — those chunks ARE the assistant's text. For a CLI harness they are
 * protocol: a client concatenating deltas received
 * `{"type":"thread.started",...}` and internal ids, while the non-streaming
 * call on the same endpoint returned the parsed answer.
 *
 * It lives here, apart from the request handler, because the bug is only
 * visible in the DIFFERENCE between those two event shapes — and a test that
 * drives the HTTP server can only produce one of them per machine. An
 * endpoint-backed test cannot tell "forward everything" from "forward the
 * answer" (both look right), and a CLI-backed one depends on which harnesses
 * happen to be installed, which is how a green test ends up proving nothing.
 * As a function over an event sequence, both shapes are ordinary inputs.
 */

import type { DispatcherEvent } from "../types.js";

/**
 * Returns the text to emit for one event, or undefined for events a user
 * should not see.
 *
 * Stateful by necessity: whether the final parsed answer should be sent
 * depends on whether anything was already streamed. Sending both would deliver
 * the answer twice.
 */
export function createAnswerStream(): (event: DispatcherEvent) => string | undefined {
  let streamedAnswer = false;
  return (event) => {
    if (event.type === "stdout" && event.text === true) {
      streamedAnswer = true;
      return event.chunk;
    }
    if (event.type === "completion" && event.result.success) {
      if (streamedAnswer || event.result.output === "") return undefined;
      return event.result.output;
    }
    return undefined;
  };
}
