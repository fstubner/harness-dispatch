/**
 * What a streaming HTTP client should be shown, from what a dispatcher emits.
 *
 * Not every stdout chunk belongs in `delta.content`. For an OpenAI-compatible
 * endpoint those chunks ARE the assistant's text; for a CLI harness they are
 * protocol, so a client concatenating deltas would receive
 * `{"type":"thread.started",...}` and internal ids where the non-streaming
 * call on the same endpoint returns the parsed answer.
 *
 * It lives here, apart from the request handler, because the mistake is only
 * visible in the DIFFERENCE between those two event shapes — and a test that
 * drives the HTTP server can only produce one of them per machine. An
 * endpoint-backed test cannot tell "forward everything" from "forward the
 * answer" (both look right), and a CLI-backed one depends on which harnesses
 * happen to be installed. As a function over an event sequence, both shapes
 * are ordinary inputs.
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
export function createAnswerStream(): AnswerStream {
  let streamedAnswer = false;
  return {
    next(event) {
      if (event.type === "stdout" && event.text === true) {
        streamedAnswer = true;
        return event.chunk;
      }
      if (event.type === "completion" && event.result.success) {
        if (streamedAnswer || event.result.output === "") return undefined;
        return event.result.output;
      }
      return undefined;
    },
    get committed() {
      return streamedAnswer;
    },
  };
}

export interface AnswerStream {
  /** Text to emit for this event, or undefined for events a user should not see. */
  next(event: DispatcherEvent): string | undefined;
  /**
   * True once any answer text has been sent to the client.
   *
   * Once it is, this request is COMMITTED to the route that sent it, and a
   * failure has to end the response rather than fall back.
   *
   * Falling back after streaming gives the worst of both: a fresh answer
   * cannot be spliced onto a half-sent one without garbling it, so the client
   * keeps the partial deltas plus an error frame while the fallback route's
   * successful answer is produced, charged for, and thrown away.
   *
   * Stopping is the honest resolution: the client gets a truthful error
   * instead of a mangled message, and no second route is billed for work that
   * could never be delivered. Falling back BEFORE anything is sent still
   * happens, which is the case fallback exists for.
   */
  readonly committed: boolean;
}
