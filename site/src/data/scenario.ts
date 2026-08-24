/**
 * The canonical hero scenario — the ONLY source of hero-transcript content.
 *
 * Rule 1 + 6 of site/docs/design-spec.md:
 * everything here mirrors what the live MCP surface (src/mcp/tools.ts —
 * DispatchResponse / DispatchPollResponse) can actually return at each
 * moment. Constraints encoded below, do not violate when editing:
 *  - A pending single-mode dispatch has NO route name (the router hasn't
 *    committed yet) — only jobId / nextPollSeconds.
 *  - Anything resolving inline that outlives the 25s default grace window
 *    must show an explicit graceSeconds in its REQUEST.
 *  - Fanout collapsed-line duration is the MAX across routes (parallel),
 *    tokens are the SUM (independent real usage).
 */

export interface RequestRow {
  key: string;
  value: string;
}

export type ToolCallResult =
  | { kind: "steps"; steps: { marker: string; text: string; gapText?: string }[] }
  | { kind: "list"; items: string[] };

export interface ToolCallData {
  /** Collapsed-line label after the tool name, e.g. "execute" or "review, fanout". */
  label: string;
  /** Collapsed-line outcome: `<route(s)> · <tokens> · <duration>` (rule 2). */
  outcome: string;
  request: RequestRow[];
  result: ToolCallResult;
}

export const transcript = {
  userPrompt:
    "Refactor the retry logic in the payment queue so it backs off exponentially, then have someone check whether the new backoff still meets our SLA doc, and review the tests once it's done.",
  agentIntro:
    "I have harness-dispatch connected — Codex, Claude Code, and Cursor are all configured. I'll send the backoff refactor over first.",
  pendingLine: "dispatch — running (job-8f2a1c3d), checking back in ~5 min",
  waitNote:
    "That'll take a few minutes — I'll check back rather than block on it, then get the SLA question and test review going.",
  afterExecute:
    "Backoff's in — routed to codex_cli. Kicking off the SLA check and test review now.",
  closing:
    "Matches the SLA doc, both reviewers are happy. Want me to open the PR?",
};

export const executeCall: ToolCallData = {
  label: "execute",
  outcome: "codex_cli · 8.4k in / 2.9k out · 4m12s",
  request: [
    { key: "task type", value: "execute" },
    { key: "prompt", value: "Refactor retry logic in payment queue for exponential backoff" },
  ],
  result: {
    kind: "steps",
    steps: [
      { marker: "1", text: "dispatch → pending, jobId job-8f2a1c3d" },
      { marker: "2", text: "job_status → codex_cli · 8,412 in / 2,896 out · 4m12s", gapText: "~5 min later" },
    ],
  },
};

export const fanoutCall: ToolCallData = {
  label: "review, fanout",
  outcome: "claude_code_cli + cursor_cli · 5.8k in / 1.5k out · 2m48s",
  request: [
    { key: "task type", value: "review" },
    { key: "prompt", value: "Does the new backoff meet docs/sla.md? Review the updated tests." },
    { key: "graceSeconds", value: "200" },
  ],
  result: {
    kind: "list",
    items: [
      "claude_code_cli → matches SLA, 2 notes · 3,201 in / 850 out · 2m48s",
      "cursor_cli → tests look solid · 2,614 in / 640 out · 1m56s",
    ],
  },
};
