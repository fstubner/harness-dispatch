# harness-dispatch

Turns your locally installed coding harnesses (Claude Code, Codex, Cursor Agent,
Antigravity CLI) and local or remote API endpoints into tools any AI can call, and
handles the async nature of long-running agent work.

Exposing them as explicit tools is more reliable than telling an agent to shell out
to another CLI: models are trained on tool calling, so they actually use tools they
are given. Each call is routed to the backend that fits the task, preferring the
flat-rate subscription quota you already pay for; metered or unknown-billing routes
are blocked until you opt in. Long tasks run as async jobs: start one, get an id back
immediately, poll for partial output, collect the result when it finishes. Nothing is
lost to a client timeout. (There is no Gemini CLI dispatcher; Google discontinued
that CLI's backend in mid-2026, and Antigravity CLI is its replacement.)

**What this does on your machine**, stated plainly before you install it: it spawns the
CLI subprocesses above with your prompts, which can read and write files under the
`workingDir` you pass it (this is the point — it's a coding agent router) and, depending
on the workspace/safety policy in effect, run shell commands via those CLIs. Running
`serve` additionally binds a local HTTP port (loopback by default, bearer-token gated —
see [HTTP Surface](#http-surface) before pointing `--host` anywhere else). Nothing here
is unusual for a coding-agent tool, but it's worth having in one place rather than
inferred from separate sections.

**A configured harness runs automatically** — nothing extra to switch on. If that
harness's account has paid/overage billing enabled on the *provider's* side (Cursor's
on-demand billing, Claude's usage credits, Codex's flexible credits, a raw metered API
key, etc.), harness-dispatch will use it too — it does not detect or prevent provider-side
billing state. It only blocks a route by default when there's no provider-side backstop
at all (a raw metered API key, or unknown billing), until you set `allow_paid_usage: true`
on it. See [Adding a harness](#adding-a-harness) for the config, and `status --json` /
`status`'s `note:` lines for a given route's billing classification.

## Requirements

- Node.js `>=24.0.0`
- At least one configured harness or OpenAI-compatible endpoint

## Install

```bash
npm install -g harness-dispatch
harness-dispatch configure --yes
harness-dispatch doctor --live
```

`configure --yes` detects installed harnesses and writes `config.yaml`.
Without `--yes` it only previews what it would detect and writes nothing —
useful to check first, but not a substitute for the real run above. `doctor`
then verifies the install end-to-end: binary + config load, harness
detection, auth/billing classification, and route readiness. `--live` goes one
step further and routes a single tiny prompt through the best eligible route so
you see a real completion before wiring the server into your agent. The live
probe respects billing policy — it never touches paid or unknown-billing routes
unless you pass `--allow-paid`.

Your Claude Code / Codex / Cursor subscriptions run by default, no opt-in needed
— `configure`'s output tells you if anything's blocked and why. See
[Adding a harness](#adding-a-harness) below for the config and the paid-usage note.

> This project was renamed from `harness-router` to `harness-dispatch` — the npm
> package, CLI command, env var prefix (`HARNESS_DISPATCH_*`), and MCP resource URIs
> (`harness-dispatch://status`) all changed together. If you have an older install,
> `npm uninstall -g harness-router && npm install -g harness-dispatch` and update any
> `mcpServers`/`claude_desktop_config.json` entry to invoke `harness-dispatch`, not the
> old command. Two older packages predate this rename and are no longer maintained:
> `harness-router` (`0.3.2` on the registry) and the separately-published
> `harness-router-mcp` (`0.2.0`) — both lack `usage`, `/v1/models`, `/v1/usage`,
> Antigravity support, and every fix described in this README. Note that `npx -y
> harness-dispatch` (used by the plugin's fallback launch path, see
> [plugin/README.md](./plugin/README.md)) resolves to whatever is currently on the npm
> registry, which can lag behind a local clone's `dist/`. Run `npm ls -g harness-dispatch`
> to check which version is actually installed.

You can also run without a global install:

```bash
npx harness-dispatch configure
```

### Plugin install (Claude Code / Claude Desktop / Codex)

The `plugin/` directory packages the MCP server plus a delegation skill and
`/route` + `/jobs` commands for one-step installs — see
[plugin/README.md](./plugin/README.md). Claude Code:
`/plugin marketplace add <repo path or URL>` then
`/plugin install harness-dispatch@harness-dispatch`. Codex:
`node plugin/scripts/install-codex.mjs`.

## Adding a harness

`config.yaml` is entirely optional. There is no separate hidden defaults format —
harness-dispatch ships with its own [`config.default.yaml`](config.default.yaml), the
same shape you'd write yourself, and reads it as its built-in config. With no
`config.yaml` of your own, the shipped one is filtered down to whichever of `claude`,
`codex`, `agy` (Antigravity), and `cursor-agent` are on your PATH:

```yaml
# config.yaml can be empty, or not exist at all.
```

Adding a harness that isn't auto-detected — a second Codex route pinned to a specific
model, or a local/hosted OpenAI-compatible endpoint — is a few lines:

```yaml
clis:
  - name: codex_sol
    harness: codex        # picks the dispatcher: claude_code | codex | cursor | antigravity_cli | generic
    model: gpt-5.6-sol
    tier: 1

endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: qwen2.5-coder
    tier: 3
```

See the shipped [`config.default.yaml`](config.default.yaml) for the full field
reference (capability weights, tiers, escalation, workspace policy, and more) — copy
it to your own `config.yaml` and edit, or run `harness-dispatch configure` to generate
a starting point.

**A wholly new CLI harness — one of the 4 built in isn't it — needs no new code
either.** `harness: generic` takes a `protocol:` block instead of reusing one of the
4 built-in harnesses' flag/output conventions. `protocol.args` is a literal
command-line argument list, written the same way you'd type it by hand — a handful of
reserved `{{name}}` tokens are substituted (or expanded to zero or more real tokens) at
dispatch time; everything else passes through verbatim:

```yaml
clis:
  - name: my_custom_cli
    harness: generic
    command: my-cli           # the binary, resolved on PATH like any other
    tier: 3
    protocol:
      args: ["-p", "{{prompt}}", "{{working_dir}}", "{{model}}", "{{safety}}", "--json"]
      working_dir: { flag: "--cd" }              # omit {{working_dir}}/this to rely on process cwd alone
      model: { flag: "--model" }                 # omit {{model}}/this if the CLI has no model override
      safety:                                     # args per requested safety profile, via {{safety}}
        read_only: ["--mode", "plan"]
        workspace_edit: ["--mode", "accept-edits"]
        full_auto: ["--dangerously-skip-permissions"]
      output:
        mode: json_field    # text | json_field | jsonl_stream
        fields: [result, output, text]   # checked in order; dotted paths work ("message.content")
```

The full token reference:

| Token | Expands to |
| --- | --- |
| `{{prompt}}` | the prompt text (one token) — omitted entirely if `stdin: true` |
| `{{model}}` | `[model.flag, value]` if a model is set, else nothing |
| `{{safety}}` | `safety[requested profile]` — zero or more tokens |
| `{{working_dir}}` | `[working_dir.flag, dir, ...working_dir.extra_args_when_set]` if set, else nothing |
| `{{file_dirs}}` | `[file_dirs.flag, dir]` repeated once per included file's directory |
| `{{native_args}}` | `endpoint_native_args[endpoint_provider]`, only under `endpoint_mode: harness_native_endpoint` |

**Protocols are named and selectable, not just inline.** `claude_code`, `codex`,
`cursor`, and `antigravity_cli` are registered presets — every entry's `harness:` value
in the shipped [`config.default.yaml`](config.default.yaml)'s `clis:` list is
automatically selectable as a preset name. Reference one by name instead of retyping it:

```yaml
clis:
  - name: my_cursor_fork
    harness: generic
    command: my-cursor-fork-cli   # a different binary that happens to share Cursor's CLI shape
    protocol: cursor
```

Or start from a preset and override just what differs, for the common "95% the
same, one flag different" case — `safety` merges per-profile (overriding just
`full_auto` doesn't erase `read_only`/`workspace_edit` from the preset):

```yaml
clis:
  - name: my_codex_fork
    harness: generic
    command: my-codex-fork-cli
    protocol:
      extends: codex
      model: { flag: "--llm-model" }  # only this differs from the codex preset
      safety:
        full_auto: ["--yolo"]         # only this profile's args are replaced
```

A built-in route's own `protocol:` (under `overrides.claude_code_cli`, etc.) accepts a
preset name or `extends:` too — it's parsed through the exact same code path as any
other route.

The `harness: claude_code | codex | cursor | antigravity_cli` routes aren't special
either — there is no per-harness dispatcher class or hardcoded TypeScript data for any
of them in this codebase. All 4 are ordinary `clis:` entries in the shipped
[`config.default.yaml`](config.default.yaml) — not a separate "defaults registry" in
some other format, loaded through the exact same parser as your own `config.yaml`,
covering each CLI's real flags including Codex's mid-run tool_use/thinking/usage
streaming events via `event_rules` (see below). Every CLI-type route — built-in or
user-added — runs through the one `GenericCliDispatcher` interpreter. Copy an entry
from the shipped file into your own `config.yaml` and edit it directly (or add a
`protocol:` block under `overrides.claude_code_cli`, etc.) and it replaces the default
entirely — nothing about the 4 built-ins is more hardcoded than a route you add
yourself.

For a CLI whose events don't fit `text`/`json_field`'s single-parse-at-exit model —
mid-run tool_use/thinking surfacing, token-usage aggregation across lines — use
`output.mode: jsonl_stream` with `output.event_rules`:

```yaml
      output:
        mode: jsonl_stream
        event_rules:
          - when: { type: "message" }             # every listed field must match this line
            emit: text
            text_field: message.content            # dotted paths work
          - when: { "item.type": "tool_use" }
            emit: tool_use
            name_field: item.name
            input_field: item.input
          - when: { type: "thinking" }
            emit: thinking
            chunk_field: item.text
          - when: {}                                # omit `when` (or leave it empty) to match every line
            emit: usage
            input_token_fields: [usage.input_tokens, usage.prompt_tokens]   # first present wins
            output_token_fields: [usage.output_tokens, usage.completion_tokens]
```

Other fields worth knowing: `file_dirs: { flag: ... }` (paired with `{{file_dirs}}`)
repeats a flag once per unique file directory (Antigravity's `--add-dir`);
`api_key_env_var` injects `api_key` under a named env var for the child process (and
clears it if ambient but unconfigured, so a stray key never leaks into a
subscription-auth call); `success_requires_output: false` switches from the default
strict contract (exit 0 AND a non-empty parsed field) to the lenient one Claude
Code/Codex/Antigravity use (exit 0 alone, falling back to raw stdout/stderr text when
parsing yields nothing). Billing for a `generic` route defaults to `unknown` (blocked
until you classify it — there's no way to know an arbitrary CLI's real billing model) —
set `billing_kind:` / `paid_usage_possible:` explicitly once you know it.

## CLI

```bash
harness-dispatch                         # stdio MCP
harness-dispatch configure               # detect harnesses and prepare config
harness-dispatch configure --print       # inspect generated config YAML
harness-dispatch doctor                  # validate install, auth, config, and routes
harness-dispatch doctor --live           # run one eligible live routed probe
harness-dispatch doctor --live --allow-paid
harness-dispatch status                  # readable route readiness
harness-dispatch status --json           # structured route metadata
harness-dispatch status --watch          # live status refresh
harness-dispatch usage                   # per-route call counts, quota, billing kind
harness-dispatch usage --json            # structured usage metadata
harness-dispatch serve --port 3333       # /mcp and /v1/* over local HTTP
harness-dispatch auth show               # print HTTP bearer token
harness-dispatch auth rotate             # rotate HTTP bearer token
```

Hidden compatibility aliases currently map old alpha commands to the new surface:
`dashboard` and `list-services` map to `status`, and `mcp --http <port>` maps to `serve`.
They are not part of the public v0.4.0 vocabulary.

## MCP Surface

`tools/list` returns three tools:

| Tool | Purpose |
| --- | --- |
| `dispatch` | Always starts new routed coding work — one task to the best-fit harness, or a fanout to several for independent opinions. Every call runs as a background job from the first moment: a fast task returns its full result inline (`completed: true`), a slow one returns `completed: false` plus a `jobId` to check on. Nothing is ever lost to a timeout — including the MCP call's own. |
| `job_status` | Checks work started by `dispatch`. Pass the `jobId` it returned to get a `partialOutput` tail while running and the full `result` once done; omit `jobId` to list every known background dispatch. |
| `usage` | Per-route call counts, quota, billing kind, and breaker state for the current session — check this before passing an unfamiliar `hints.model`/`service`/`models` value, since those are not validated. Pass `listModels: <route id>` to fetch that `openai_compatible` route's live `GET /models` catalog instead of (or alongside) the summary. |

`workingDir` is effectively required when starting work: if you omit it, the task runs
in the router server's own process directory instead of your project, and the response
carries a `warning` field saying so.

**How the grace window works.** `dispatch` starts the task as a background job
immediately, then waits up to `graceSeconds` (default 25) for it to finish. Within the
window you get the complete result inline, exactly as if the call had blocked. Past it
you get the `jobId` — call `job_status` with that `jobId` to see a `partialOutput` tail
while it runs and the full `result` once `completed`. Because the run never depends on
the MCP call staying open, a client-side timeout costs you the inline reply, never the
work. Background runs default to a generous 60-minute ceiling meant only to catch a
genuinely hung process (stuck waiting on input, a stalled network call), not to cap
normal work — raise it per call with `hints.timeoutMs` (milliseconds), or set a
permanent per-route default with `timeout_ms:` in that service's config entry.
Precedence is `hints.timeoutMs` > the service's `timeout_ms` > the 60-minute default.

Starting a task:

```json
{
  "prompt": "Review this package for release blockers.",
  "files": [],
  "workingDir": "/path/to/project",
  "workspacePolicy": "shared_locked",
  "hints": {
    "model": "gpt-5.4",
    "taskType": "review",
    "preferLargeContext": false,
    "safetyProfile": "workspace_edit"
  }
}
```

For fanout (each route that outlives the grace window returns its own `jobId`):

```json
{
  "mode": "fanout",
  "prompt": "Compare the maintainability tradeoffs in this refactor.",
  "models": ["claude-opus-4-6", "gpt-5.4"],
  "workspacePolicy": "copy",
  "hints": {
    "taskType": "plan",
    "safetyProfile": "workspace_edit"
  }
}
```

Checking and listing (`job_status`): `{"jobId": "job-..."}` returns status plus
`partialOutput` or the final `result`; `{}` (no `jobId`) returns every known background
dispatch. On `dispatch`, force pure async with `"graceSeconds": 0`, or force a specific
backend with a top-level `"service"` (single mode only). Nothing is lost by checking
late — everything persists under `~/.harness-dispatch/jobs/<jobId>/`.

Status is exposed as resources:

- `harness-dispatch://status`
- `harness-dispatch://status.json`

## HTTP Surface

`harness-dispatch serve` starts an authenticated local server on `127.0.0.1`.

Endpoints:

- `POST /mcp` for streamable HTTP MCP
- `GET /v1/status` — full route/quota/billing/breaker detail (same shape as
  `harness-dispatch://status.json`)
- `GET /v1/usage` — per-route call counts, quota, billing kind, and breaker state only
- `GET /v1/models` — OpenAI-style model list; each entry's `id` is a route id you can
  pass as `model` in `/v1/chat/completions`
- `POST /v1/chat/completions`

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
`/v1/chat/completions`. The `model` field is treated as a routing/model hint.

## Endpoint Modes

Harness Router supports two local/custom endpoint patterns:

- `direct_openai_compatible`: Harness Router calls an OpenAI-compatible
  `/v1/chat/completions` endpoint directly. This is the right mode for Ollama,
  LM Studio, vLLM, LiteLLM, and private local HTTP model servers.
- `harness_native_endpoint`: a downstream CLI keeps its agent scaffold but is
  pointed at a supported local provider. Codex currently supports this for
  `ollama` and `lmstudio` through `--oss --local-provider`.

Example direct local route:

```yaml
endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: qwen2.5-coder
    endpoint_mode: direct_openai_compatible
    endpoint_provider: ollama
    wire_protocol: openai_chat_completions
```

Example Codex harness-native local route:

```yaml
services:
  codex_ollama:
    enabled: true
    type: cli
    harness: codex
    command: codex
    model: qwen3-coder:latest
    endpoint_mode: harness_native_endpoint
    endpoint_provider: ollama
    wire_protocol: openai_chat_completions
    billing_kind: local_compute
    paid_usage_possible: false
    tier: 3
    weight: 0.75
    cli_capability: 1.0
    timeout_ms: 900000  # optional; overrides the dispatcher's default (10 min for CLIs)
    capabilities:
      execute: 0.8
      plan: 0.7
      review: 0.7
```

## Configure

`configure` is the main setup flow:

1. Detect installed harnesses.
2. Verify configured routes without spending quota where possible.
3. Classify auth and billing so paid or unknown-paid routes are not selected by accident.
4. Choose routed harnesses, model priority, and safety profile.
5. Write v0.4 config YAML.
6. Connect selected MCP agents or print snippets.

The current command is conservative: it prints detected routes by default and writes
only when explicitly asked with `--yes`.

## Status Model

`status --json`, `/v1/status`, and `harness-dispatch://status.json` share the same
shape. Each route includes:

- route id and harness
- billing provider, surface, auth source, billing kind, paid-use flags, and confidence
- configured and effective safety profile
- effective workspace policy
- availability
- tier and model metadata
- quota score and local call count
- circuit breaker state
- skip reason when a route is disabled, unavailable, paid-blocked, unknown-billing,
  safety-incompatible, or circuit-broken
- token limits when known

Safety profiles:

- `read_only`: inspect-only routes.
- `workspace_edit`: default; routes may edit files in the workspace without broad shell access.
- `full_auto`: permits routes that require shell/write automation beyond workspace-edit mode.

Workspace policy:

- `shared`: run directly in the caller's `workingDir`.
- `shared_locked`: run directly in `workingDir`, but serialize write-capable
  dispatches for the same directory inside one router process.
- `copy`: copy the project into `.harness-dispatch/workspaces/...`, run the agent
  there, and return the isolated workspace path plus changed-file metadata.
- `git_worktree`: create a detached git worktree for the route and return the
  worktree path plus changed-file metadata. This starts from `HEAD`, so
  uncommitted source-workspace changes are not copied.

Write-capable fanout is allowed only with `workspacePolicy: "copy"` or
`workspacePolicy: "git_worktree"`. These modes isolate project state and process
cwd. They are not hardened OS sandboxes: a route with broad shell permission can
still access the host unless the downstream harness or operating system enforces
that boundary.

Provider notes:

- Claude Code `claude -p` is treated date-aware: before June 15, 2026 it is classified
  as plan usage; from June 15, 2026 it is classified as Agent SDK credits with possible
  overage.
- Codex CLI/SDK uses the official Codex product surface unless a route is explicitly
  configured with an API key, in which case it is API billing.
- Cursor Agent CLI is classified as included usage with possible on-demand continuation.
- OpenAI-compatible `api.openai.com` routes are metered; known local runtimes are local;
  unknown loopback/custom endpoints require explicit billing metadata.

## Observability & Privacy

harness-dispatch contains **no phone-home telemetry** — nothing is ever sent to
the author or any third party. OpenTelemetry tracing is available for your own
use, but **it is off by default** — nothing OpenTelemetry-related initializes
unless you opt in:

- Enable it with `telemetry: { enabled: true }` in `config.yaml`, or the
  `HARNESS_DISPATCH_TELEMETRY=1` env var.
- Once enabled, traces export via OTLP/HTTP to `http://localhost:4318` (the
  standard local collector port) by default. If nothing is listening there,
  spans are simply dropped — no data leaves your machine.
- Traces only go somewhere else if *you* set `OTEL_EXPORTER_OTLP_ENDPOINT` to
  a remote collector.
- `OTEL_SDK_DISABLED=true` forces initialization off even if `telemetry:` is
  enabled in config.

Every dispatch also appends one JSONL line to a local
dispatch log at `~/.harness-dispatch/logs/dispatches.jsonl` (override the
directory with `HARNESS_DISPATCH_LOG_DIR`) — route, success, duration, token
counts, and a capped error string, for post-hoc debugging. It's local-only,
size-capped via single-file rotation, and never sent anywhere. Job artifacts
(prompt, snapshotted files, stdout/stderr, result) live under
`~/.harness-dispatch/jobs/<jobId>/` and are pruned after 7 days of inactivity by
default — set `retention: { jobs_days: N }` in `config.yaml` (or
`HARNESS_DISPATCH_JOB_MAX_AGE_MS` for a millisecond override) to change that
window.

Prompts and outputs otherwise flow only to the harnesses/endpoints you
configured. The router's only network call by default is the leaderboard
refresh — a GET of public Arena ELO benchmark data from `api.wulong.dev` used
for route scoring; it sends nothing about you or your prompts.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
npm audit --omit=dev
npm pack --dry-run
```

Live agent workflow smoke tests are opt-in because they call real harnesses and
can consume quota or product-plan usage. They create a disposable tiny Node
project under `.harness-dispatch/smoke-workspaces`, write the detailed task into a
workspace-local `.harness-dispatch/agent-task.md`, send the harness a short prompt
pointing at that brief, then verify `node test.mjs` passes.

```powershell
$env:HARNESS_DISPATCH_LIVE_AGENT_SMOKE = '1'
npm run build
npm run smoke:agents -- --config config.yaml
```

To temporarily include routes that can incur paid usage:

```powershell
$env:HARNESS_DISPATCH_LIVE_AGENT_SMOKE = '1'
npm run smoke:agents -- --config config.yaml --allow-paid
```

To include Cursor's full-auto print-mode route:

```powershell
$env:HARNESS_DISPATCH_LIVE_AGENT_SMOKE = '1'
npm run smoke:agents -- --config config.yaml --allow-paid --safety full_auto
```

Release gates:

```bash
npm run check
npm run build
npm run test:coverage
npm run smoke
npm audit --omit=dev
npm pack --dry-run
```

Before publishing, also run `smoke:agents` with the installed harnesses you want
to claim as validated, and record which routes passed, failed, or were skipped.
Set `HARNESS_DISPATCH_AGENT_SMOKE_ROOT` only when you need the disposable
workspaces somewhere other than the repo-local shared smoke cache.
