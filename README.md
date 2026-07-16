# harness-router

Local routing for coding agents and coding harnesses.

`harness-router` sits between an agent client and the coding tools you already use:
Claude Code, Codex, Cursor Agent, Antigravity CLI, and OpenAI-compatible local or metered
endpoints. It detects available harnesses, verifies route readiness, applies billing
and safety policy, and exposes a small MCP surface plus an OpenAI-compatible HTTP surface.
(There is no Gemini CLI dispatcher — Google discontinued that CLI's backend in mid-2026;
Antigravity CLI is its replacement.)

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
key, etc.), harness-router will use it too — it does not detect or prevent provider-side
billing state. It only blocks a route by default when there's no provider-side backstop
at all (a raw metered API key, or unknown billing), until you set `allow_paid_usage: true`
on it. See [Adding a harness](#adding-a-harness) for the config, and `status --json` /
`status`'s `note:` lines for a given route's billing classification.

## Requirements

- Node.js `>=24.0.0`
- At least one configured harness or OpenAI-compatible endpoint

## Install

```bash
npm install -g harness-router
harness-router configure --yes
harness-router doctor --live
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

> This repo publishes as `harness-router` (currently `0.4.0` here vs. an older `0.3.2`
> on the registry). A separate, older package named `harness-router-mcp` (`0.2.0`) also
> exists on npm from an earlier iteration of this project — it lacks `usage`,
> `/v1/models`, `/v1/usage`, Antigravity, and every fix in this README's changelog.
> Double-check any `mcpServers`/`claude_desktop_config.json` entry actually invokes
> **this** package (or your local build's `dist/bin.js`), not the old one.

You can also run without a global install:

```bash
npx harness-router configure
```

### Plugin install (Claude Code / Claude Desktop / Codex)

The `plugin/` directory packages the MCP server plus a delegation skill and
`/route` + `/jobs` commands for one-step installs — see
[plugin/README.md](./plugin/README.md). Claude Code:
`/plugin marketplace add <repo path or URL>` then
`/plugin install harness-router@harness-router`. Codex:
`node plugin/scripts/install-codex.mjs`.

## Adding a harness

`config.yaml` is entirely optional. With none at all, harness-router auto-detects
whichever of `claude`, `codex`, `agy` (Antigravity), and `cursor-agent` are on your
PATH and routes across them with built-in defaults — that's the whole default config:

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

See `config.example.yaml` for the full field reference (capability weights, tiers,
escalation, workspace policy, and more).

**A wholly new CLI harness — one of the 4 built in isn't it — needs no new code
either.** `harness: generic` takes a `protocol:` block instead of reusing one of the
4 built-in dispatchers' hardcoded flag/output conventions:

```yaml
clis:
  - name: my_custom_cli
    harness: generic
    command: my-cli           # the binary, resolved on PATH like any other
    tier: 3
    protocol:
      prompt_input: { mode: flag, flag: "-p" }   # or {mode: positional} / {mode: stdin}
      working_dir: { flag: "--cd" }              # omit to rely on process cwd alone
      model_flag: "--model"                      # omit if the CLI has no model override
      extra_args: ["--json"]                     # always appended
      safety_args:                                # extra args per requested safety profile
        read_only: ["--mode", "plan"]
        workspace_edit: ["--mode", "accept-edits"]
        full_auto: ["--dangerously-skip-permissions"]
      output_mode: json_field    # text | json_field | jsonl_stream
      output_fields: [result, output, text]   # checked in order; dotted paths work ("message.content")
```

The `harness: claude_code | codex | cursor | antigravity_cli` routes aren't special
either — each ships a default `protocol:` (in `builtin-protocols.ts`) covering that
CLI's real flags, including Codex's mid-run tool_use/thinking/usage streaming events
via `event_rules` (see below), through the exact same `GenericCliDispatcher`
interpreter every route runs on. Put a `protocol:` block under `overrides.claude_code_cli`
(or any built-in route) in config.yaml and it replaces the default entirely — nothing
about the 4 built-ins is more hardcoded than a route you add yourself.

For a CLI whose events don't fit `text`/`json_field`'s single-parse-at-exit model —
mid-run tool_use/thinking surfacing, token-usage aggregation across lines — use
`output_mode: jsonl_stream` with `event_rules`:

```yaml
      output_mode: jsonl_stream
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

Other fields worth knowing: `file_dirs_flag` repeats a flag once per unique file
directory (Antigravity's `--add-dir`); `api_key_env_var` injects `api_key` under a
named env var for the child process (and clears it if ambient but unconfigured, so a
stray key never leaks into a subscription-auth call); `success_requires_output: false`
switches from the default strict contract (exit 0 AND a non-empty parsed field) to the
lenient one Claude Code/Codex/Antigravity use (exit 0 alone, falling back to raw
stdout/stderr text when parsing yields nothing). Billing for a `generic` route defaults
to `unknown` (blocked until you classify it — there's no way to know an arbitrary CLI's
real billing model) — set `billing_kind:` / `paid_usage_possible:` explicitly once you
know it.

**A harness runs as soon as it's configured — no separate "enable" step.** If that
harness's account has paid/overage billing enabled on the *provider's* side, harness-
router will use it too; it does not detect or prevent provider-side billing state
(there's no API for that on any of Claude/Codex/Cursor). It only blocks a route by
default when there's no provider-side backstop at all — a raw metered API key, or
unknown billing — until you set `allow_paid_usage: true` on it.

## CLI

```bash
harness-router                         # stdio MCP
harness-router configure               # detect harnesses and prepare config
harness-router configure --print       # inspect generated config YAML
harness-router doctor                  # validate install, auth, config, and routes
harness-router doctor --live           # run one eligible live routed probe
harness-router doctor --live --allow-paid
harness-router status                  # readable route readiness
harness-router status --json           # structured route metadata
harness-router status --watch          # live status refresh
harness-router serve --port 3333       # /mcp and /v1/* over local HTTP
harness-router auth show               # print HTTP bearer token
harness-router auth rotate             # rotate HTTP bearer token
```

Hidden compatibility aliases currently map old alpha commands to the new surface:
`dashboard` and `list-services` map to `status`, and `mcp --http <port>` maps to `serve`.
They are not part of the public v0.4.0 vocabulary.

## MCP Surface

`tools/list` returns three tools:

| Tool | Purpose |
| --- | --- |
| `code` | Route one coding task or fan out to multiple selected models. Blocks until the harness finishes — only safe for short (under ~1-2 min) tasks. |
| `job` | Start (returns a `jobId` immediately) or inspect an async route job. Preferred for anything slower, since it can't hit an MCP client timeout. |
| `usage` | Per-route call counts, quota, billing kind, and breaker state for the current session — check this before passing an unfamiliar `hints.model`/`service`/`models` value, since those are not validated. |

`workingDir` is effectively required on `code` and `job`: if you omit it, the task runs
in the router server's own process directory instead of your project, and the response
carries a `warning` field saying so.

**`code` and `job` use different dispatch-timeout defaults.** `code` blocks the MCP
call regardless, so it uses each route's short built-in default (10 minutes for CLI
harnesses, 2 minutes for `openai_compatible` endpoints). `job` runs in the background
and is polled, so nothing requires killing a healthy process that quickly — it defaults
to a generous 60-minute ceiling instead, meant only to catch a genuinely hung process
(stuck waiting on input, a stalled network call), not to cap normal work. Either way,
past the applicable default the result is discarded, not truncated. Raise it further
per call with `hints.timeoutMs` (milliseconds), or set a permanent per-route default
with `timeout_ms:` in that service's config entry — precedence is `hints.timeoutMs` >
the service's `timeout_ms` > the mode's default.

`code` accepts:

```json
{
  "mode": "single",
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

For fanout:

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

`job` with `action: "start"` returns a `jobId` plus `nextPollSeconds` and `instructions`
telling the caller how long to wait before calling `action: "get"` with that `jobId`.
While still running, `get` returns a `partialOutput` tail of live stdout/stderr; once
`status` is `completed` or `failed`, it returns the full `result`. Nothing is lost by
polling late — everything persists under `~/.harness-router/jobs/<jobId>/`.

Status is exposed as resources:

- `harness-router://status`
- `harness-router://status.json`

## HTTP Surface

`harness-router serve` starts an authenticated local server on `127.0.0.1`.

Endpoints:

- `POST /mcp` for streamable HTTP MCP
- `GET /v1/status` — full route/quota/billing/breaker detail (same shape as
  `harness-router://status.json`)
- `GET /v1/usage` — per-route call counts, quota, billing kind, and breaker state only
- `GET /v1/models` — OpenAI-style model list; each entry's `id` is a route id you can
  pass as `model` in `/v1/chat/completions`
- `POST /v1/chat/completions`

HTTP uses the bearer token from `harness-router auth show`. The same token protects
MCP-over-HTTP and `/v1/*`.

`--host <host>` overrides the default `127.0.0.1` bind address if you need to reach the
server from another machine. Only pass a non-loopback host if you actually mean to —
this exposes a bearer-token-gated server, and everything the dispatched harness can do
(spawn CLIs, read/write files in `workingDir`), to your network. `serve` prints a
warning to stderr when it detects this so it isn't silent.

Example:

```bash
TOKEN="$(harness-router auth show)"

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

`status --json`, `/v1/status`, and `harness-router://status.json` share the same
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
- `copy`: copy the project into `.harness-router/workspaces/...`, run the agent
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

harness-router contains **no phone-home telemetry** — nothing is ever sent to
the author or any third party. The built-in observability is OpenTelemetry
tracing for your own use:

- Traces export via OTLP/HTTP to `http://localhost:4318` (the standard local
  collector port) by default. If nothing is listening there, spans are simply
  dropped — no data leaves your machine.
- Traces only go somewhere else if *you* set `OTEL_EXPORTER_OTLP_ENDPOINT` to
  a remote collector.
- Set `OTEL_SDK_DISABLED=true` to skip OpenTelemetry initialization entirely.

Prompts and outputs otherwise flow only to the harnesses/endpoints you
configured. The router's only other network call is the leaderboard refresh —
a GET of public Arena ELO benchmark data from `api.wulong.dev` used for route
scoring; it sends nothing about you or your prompts.

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
project under `.harness-router/smoke-workspaces`, write the detailed task into a
workspace-local `.harness-router/agent-task.md`, send the harness a short prompt
pointing at that brief, then verify `node test.mjs` passes.

```powershell
$env:HARNESS_ROUTER_LIVE_AGENT_SMOKE = '1'
npm run build
npm run smoke:agents -- --config config.yaml
```

To temporarily include routes that can incur paid usage:

```powershell
$env:HARNESS_ROUTER_LIVE_AGENT_SMOKE = '1'
npm run smoke:agents -- --config config.yaml --allow-paid
```

To include Cursor's full-auto print-mode route:

```powershell
$env:HARNESS_ROUTER_LIVE_AGENT_SMOKE = '1'
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
Set `HARNESS_ROUTER_AGENT_SMOKE_ROOT` only when you need the disposable
workspaces somewhere other than the repo-local shared smoke cache.
