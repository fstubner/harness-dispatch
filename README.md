# harness-router

Local routing for coding agents and coding harnesses.

`harness-router` sits between an agent client and the coding tools you already use:
Claude Code, Codex, Cursor Agent, Antigravity CLI, and OpenAI-compatible local or metered
endpoints. It detects available harnesses, verifies route readiness, applies billing
and safety policy, and exposes a small MCP surface plus an OpenAI-compatible HTTP surface.
(There is no Gemini CLI dispatcher — Google discontinued that CLI's backend in mid-2026;
Antigravity CLI is its replacement.)

It is not marketed as a generic cost optimizer. The current product promise is
billing-aware, safety-aware routing for coding work, with these actual rules:

- Any route where paid usage is possible is blocked with `paid_blocked` until you
  set `allow_paid_usage: true` on that route. This covers metered API routes (e.g.
  a raw `api.openai.com` key), routes with unknown billing, and included-plan
  routes whose billing kind allows overage (e.g. the default Codex, Claude Code,
  and Cursor classifications).
- With `allow_paid_usage: true`, the route may be auto-selected like any other —
  the opt-in is per route, so you can allow overage on Codex while keeping a raw
  API endpoint blocked.
- Routes that cannot incur paid usage (`local_compute`, `free_quota`,
  `included_plan_usage`) run by default with no opt-in required.

Check a route's `billing.kind` / `billing.paidUsagePossible` in `status --json` before
assuming it is (or isn't) blocked.

## Requirements

- Node.js `>=24.0.0`
- At least one configured harness or OpenAI-compatible endpoint

## Install

```bash
npm install -g harness-router
harness-router configure
harness-router doctor --live
```

`doctor` verifies the install end-to-end: binary + config load, harness
detection, auth/billing classification, and route readiness. `--live` goes one
step further and routes a single tiny prompt through the best eligible route so
you see a real completion before wiring the server into your agent. The live
probe respects billing policy — it never touches paid or unknown-billing routes
unless you pass `--allow-paid`.

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
