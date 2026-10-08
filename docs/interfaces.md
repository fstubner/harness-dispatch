# MCP and HTTP surfaces

The two ways to call harness-dispatch: as an MCP server (the usual way), and
over HTTP for clients that speak OpenAI's API shape.

## CLI

```bash
harness-dispatch                         # stdio MCP
harness-dispatch configure               # detect harnesses and prepare config
harness-dispatch configure --print       # inspect generated config YAML
harness-dispatch connect                 # register with the MCP clients you have
harness-dispatch connect --yes           # no prompts (needs a config: configure --yes first)
harness-dispatch connect --clients cursor  # no prompt; ids from the listing it prints
harness-dispatch connect --dev           # point clients at THIS checkout's build
harness-dispatch connect --remove        # take the entry back out
harness-dispatch doctor                  # validate install, auth, config, and routes
harness-dispatch doctor --live           # run one eligible live routed probe
harness-dispatch doctor --live --allow-paid
harness-dispatch doctor --prune-state    # also delete saved breaker/usage state for routes this config does not name
harness-dispatch status                  # readable route readiness
harness-dispatch status --json           # structured route metadata
harness-dispatch status --watch          # live status refresh
harness-dispatch usage                   # per-route call counts, quota, billing kind
harness-dispatch usage --json            # structured usage metadata
harness-dispatch dispatch "<prompt>"     # route one task and print the result
harness-dispatch dispatch "<prompt>" --service codex_cli --safety read_only --task-type review --no-fallback --json
harness-dispatch breaker reset <route>   # close a tripped circuit breaker now
harness-dispatch serve --port 3333       # /mcp and /v1/* over local HTTP
harness-dispatch mcp                     # stdio MCP, same as no command (what launchers use)
harness-dispatch mcp --http 3333         # same as serve --port 3333
harness-dispatch auth show               # print HTTP bearer token
harness-dispatch auth rotate             # rotate HTTP bearer token
```

The CLI `dispatch` runs in the calling process, not as a background job, so it
is deliberately **outside** `max_concurrent_runs`: that cap bounds the detached
runners the MCP and HTTP dispatch paths start. A shell loop of `dispatch`
commands is not queued; it is as parallel as you make it.

`mcp` is supported: it is what the plugin launcher and some client entries run,
and `mcp --http <port>` is the same as `serve --port <port>`.

Hidden compatibility aliases map old alpha commands to the new surface:
`dashboard` and `list-services` map to `status`, and `route <prompt>` is an alias
of `dispatch`. They are not part of the public vocabulary and may be removed
without a major version bump.

## MCP Surface

### Protocol revisions

The server speaks MCP **2026-07-28** and the 2025-era revisions older clients
use, over stdio and on `/mcp`:

| A client that... | Gets |
| --- | --- |
| opens with `initialize` (Codex, Cursor, older Claude Code) | the revision it asks for, if it is 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 or 2024-10-07; otherwise 2025-11-25. The instructions arrive in the `initialize` result. |
| opens with `server/discover`, or sends requests carrying the 2026-07-28 `_meta` envelope with no handshake | 2026-07-28. The instructions arrive in the `server/discover` result. |

Both get the same tools, resources, progress notifications and refusals. The
client's name is recorded on each dispatch either way: from the request's
`_meta` (2026-07-28) or from the `initialize` handshake. On stdio the first
message decides, for the life of the process. A client that probes with
`server/discover` and then falls back to `initialize` is served as 2025-era.

`tools/list` returns six tools:

| Tool | Purpose |
| --- | --- |
| `dispatch` | Always starts new routed coding work — one task to the best-fit harness, or a fanout to several for independent opinions. Every call runs as a background job from the first moment: a fast task returns its full result inline (`completed: true`), a slow one returns `completed: false` plus a `jobId` to check on. Nothing is ever lost to a timeout — including the MCP call's own. |
| `job_status` | Checks work started by `dispatch`. Pass the `jobId` it returned to get a `partialOutput` tail while running and the full `result` once done; omit `jobId` to list recent background dispatches (compact, newest first, each with the `workingDir` it ran in and a `promptPreview`, so a caller can pick out its own among other sessions' jobs). |
| `cancel_job` | Stops work started by `dispatch` — a wrong turn, a wrong directory, a superseded run. A job still waiting for a slot stops outright; a running one tears down within about a second (poll `job_status` to see it land), killing the agent CLI and its children. Files it already changed are **not** reverted, and a cancelled run is not counted as a route failure. |
| `retry_job` | Re-runs a finished job's task from its own record — same prompt (as the delegate saw it), files, working directory, hints and workspace policy. Pass `service` to send the retry to a different route, which is the usual reason to retry: the task was fine and the route was not — the original's model is left behind when the new route does not declare it, reported as `droppedModel`. Returns a new jobId; the original is untouched. |
| `workspace` | For a job that ran with `workspacePolicy: "copy"` or `"git_worktree"`, the agent's changes live in an isolated workspace and were **never** applied to your project. `action: "diff"` returns the real patch; `"apply"` applies it (refusing when your project has uncommitted changes, since the patch was built against a clean base — `force: true` overrides); `"discard"` deletes the workspace. The full patch is always written to the job directory, so `git apply` by hand is available either way. |
| `usage` | Per-route call counts, quota, billing kind, and breaker state — check this before passing an unfamiliar `hints.model`/`service`/`models` value. `service` and `models` are validated — an unknown route id is rejected, naming the valid ones — while `hints.model` is forwarded to the picked harness as-is, so a wrong model name fails at the harness instead. Pass `listModels: <route id>` to get that `openai_compatible` route's model catalog instead of (or alongside) the summary: the route's declared `models:` list when it has one, otherwise a live `GET /models` from the endpoint. |

`workingDir` is effectively required when starting work: if you omit it, the task runs
in the router server's own process directory instead of your project, and the response
carries a `warning` field saying so.

**How the grace window works.** `dispatch` starts the task as a background job
immediately, then waits up to `graceSeconds` (default 25) for it to finish. Within the
window you get the complete result inline, exactly as if the call had blocked. Past it
you get the `jobId` — call `job_status` with that `jobId` to see a `partialOutput` tail
while it runs and the full `result` once `completed`. Expect the `jobId` path to be
ordinary rather than exceptional: real agent-CLI work regularly runs for minutes. On
the maintainer's install in October 2026, 200 of the 292 CLI runs in the dispatch log
that succeeded took longer than 25 seconds (68 percent), and the median retained job
took about 6.5 minutes (386 seconds, over 69 jobs). Most CLI runs therefore outlive
the default window; endpoint routes mostly do not. Treat a `completed: false` as the
normal shape of a substantial task, not as a sign anything went wrong; if you would
rather not wait inline at all, pass `graceSeconds: 0`. Because the run never depends on
the MCP call staying open, a client-side timeout costs you the inline reply, never the
work. Background runs default to a generous 60-minute ceiling meant only to catch a
genuinely hung process (stuck waiting on input, a stalled network call), not to cap
normal work — raise it per call with `hints.timeoutMs` (milliseconds), or set a
permanent per-route default with `timeout_ms:` in that service's config entry.
Precedence is `hints.timeoutMs` > the service's `timeout_ms` > the 60-minute default.
Antigravity ships its own 25-minute `timeout_ms`, and Codex and Antigravity stop a run
that has printed nothing for 15 minutes (`idle_timeout_ms`); see
[configuration](configuration.md#time-limits).

Starting a task:

```json
{
  "prompt": "Review this package for release blockers.",
  "files": [],
  "workingDir": "/path/to/project",
  "workspacePolicy": "shared_locked",
  "hints": {
    "modelTier": "standard",
    "taskType": "review",
    "preferLargeContext": false,
    "safetyProfile": "read_only"
  }
}
```

`hints.modelTier` (`cheap`, `standard` or `strong`) asks for a strength of model
without naming one. The router picks the route, and that route runs its own model for
the tier (`model_tiers:` in [configuration](configuration.md#config-reference)) — on a
fallback route too. A route with no model for the tier runs its default model, and the
reply says so with `routing.modelTierMatched: false`; `routing.modelTier` and `model`
say what ran.

To run one exact route, add a top-level `service` (a route id from `usage`), and with
it, if you need one, an exact `hints.model`. A named route has no fallback: if it is
rate-limited or fails, the dispatch fails. `hints.model` wins over `hints.modelTier`.

The reply to a job still running carries `nextPollSeconds`: about as long as the job
has already run, from 15 seconds for a job that has just started up to 5 minutes.
Checking at that pace picks up a quick job quickly without polling a long one every few
seconds.

For fanout (each route that outlives the grace window returns its own `jobId`). `models`
takes route ids from `usage` (or model names a route declares), never a model you hope
a route has; a read-only fanout needs no workspace policy, while a write-capable one
needs `workspacePolicy: "copy"` or `"git_worktree"`:

```json
{
  "mode": "fanout",
  "prompt": "Compare the maintainability tradeoffs in this refactor.",
  "workingDir": "/path/to/project",
  "models": ["claude_code_cli", "codex_cli"],
  "hints": {
    "taskType": "plan",
    "safetyProfile": "read_only"
  }
}
```

Checking and listing (`job_status`): `{"jobId": "job-..."}` returns status plus
`partialOutput` or the final `result`; `{}` (no `jobId`) returns the 20 most recent
background dispatches, newest first, plus an `omitted` count when there are more. On `dispatch`, force pure async with `"graceSeconds": 0`, or force a specific
backend with a top-level `"service"` (single mode only). Nothing is lost by checking
late — everything persists under `~/.harness-dispatch/jobs/<jobId>/`.

Status is exposed as resources:

- `harness-dispatch://status`
- `harness-dispatch://status.json`

## HTTP Surface

`harness-dispatch serve` starts an authenticated local server on `127.0.0.1`.

Endpoints:

- `GET /health` — liveness, and the **only** route served without a token, so a
  deploy gate or container probe can ask without being handed a credential. It
  answers `{"status","service","version"}` and nothing else: no routes, no
  endpoints, no quota, no config.
- `/mcp` for streamable HTTP MCP, both revisions (see
  [Protocol revisions](#protocol-revisions)). A 2025-era client gets a session
  (`mcp-session-id`) and the `GET` and `DELETE` session operations. A
  2026-07-28 request is answered on its own, with no session: it is recorded
  with its client's name and no session id. The bearer token and the 10 MiB
  body limit apply to both.
- `POST /v1/chat/completions` with `stream: true` sends the answer as SSE
  deltas. An endpoint route streams its text as it arrives; a CLI harness emits
  protocol on stdout, so its answer is sent once, at completion — the deltas
  never carry harness protocol either way. A single-route streamed request is a
  job like any other: its id arrives in the `x-harness-dispatch-job-id` response
  header, and if the connection drops the run continues and its result stays
  collectable with `job_status` (`cancel_job` stops it). A streamed fanout sends
  no such header; each arm reports its own `jobId` in the stream. A stream that
  fails (the run was cancelled, crashed, or every route or arm failed) ends with
  an `error` frame before `[DONE]`, where the non-streaming reply answers 500 or
  502. On a single-route stream the final frame carries the routed `model` and a
  `harness_dispatch` member with the `jobId` and any `warning`.
- `/mcp` answers 404 for an `mcp-session-id` the server does not hold (idle for
  30 minutes, or from before a restart), which tells a 2025-era MCP client to
  initialise a new session.
- `GET /v1/status` — full route/quota/billing/breaker detail (same shape as
  `harness-dispatch://status.json`). Authenticated, because that answer is not
  for strangers.
- `GET /v1/usage` — per-route call counts, quota, billing kind, and breaker state only
- `GET /v1/models` — OpenAI-style model list; each entry's `id` is a route id you can
  pass as `model` in `/v1/chat/completions`

HTTP uses the bearer token from `harness-dispatch auth show`. The same token protects
MCP-over-HTTP and `/v1/*`.

`--host <host>` overrides the default `127.0.0.1` bind address if you need to reach the
server from another machine. Only pass a non-loopback host if you actually mean to —
this exposes a bearer-token-gated server, and everything the dispatched harness can do
(spawn CLIs, read/write files in `workingDir`), to your network. `serve` prints a
warning to stderr when it detects this so it isn't silent.

Example:

```bash
TOKEN="$(harness-dispatch auth show)"

curl http://127.0.0.1:3333/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Fix the failing tests."}],
    "workingDir": "/path/to/project",
    "safetyProfile": "workspace_edit",
    "workspacePolicy": "copy"
  }'
```

The REST surface is OpenAI-compatible enough for local clients that can speak
`/v1/chat/completions`. The `model` field is treated as a routing/model hint;
it is also the way to pick a route here, since the MCP `service` parameter is
refused on this surface rather than silently ignored. A `model` that names a
route runs that route when it is eligible; if it is blocked or fails, the
router can still fall back to another, unlike MCP `service`. HTTP `models` for
a fanout takes route ids only.

Non-streaming completions are backed by the same persisted job pipeline as the
MCP `dispatch` tool: the reply carries `harness_dispatch.jobId`, and the same id
is sent early as an `x-harness-dispatch-job-id` response header. If your client
times out mid-run (curl defaults, CI step limits), the run still finishes and
the result persists — recover it with the `job_status` MCP tool or by reading
`~/.harness-dispatch/jobs/<jobId>/output/`.

## Chaining delegated work

Pass the jobIds of earlier dispatches as `contextJobs` and their prompts and
outputs are rendered into the new prompt directly — arguments to the `dispatch`
MCP tool, not an HTTP body (the OpenAI-compatible endpoint does not implement
`contextJobs`, and refuses it rather than accepting it and ignoring it):

```json
{ "prompt": "Now write the migration.", "contextJobs": ["job-1786977300001-0f0aaaaa"] }
```

Without it, chaining means reading the first job's output into your own context
and re-summarising it into the second prompt — which spends the context that
delegating was meant to save, and loses detail in the retelling.

Injected context is capped (24k characters total, 8k per job, 16 jobs) so it
cannot crowd out the task itself, and a referenced job that is missing or still
running is reported in the preamble rather than silently dropped.
