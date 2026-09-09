# harness-dispatch

[![npm](https://img.shields.io/npm/v/harness-dispatch?logo=npm)](https://www.npmjs.com/package/harness-dispatch)
[![CI](https://github.com/fstubner/harness-dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/fstubner/harness-dispatch/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/harness-dispatch)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/harness-dispatch)](LICENSE)

**Route whole coding tasks — not API requests — to the agent CLIs you already pay for.**

```bash
npm install -g harness-dispatch
harness-dispatch configure --yes
harness-dispatch doctor
```

Before running that: [what it does on your machine](#what-it-does-on-your-machine).

Each harness keeps its own scaffolding, test loop, and codebase index. There is no
proxy in between and nothing is re-implemented: Claude Code stays Claude Code. One
orchestrating agent picks the right one per task and spends your flat-rate
subscription quota before anything metered.

It is a local MCP server, so the harnesses on your machine — Claude Code, Codex,
Cursor Agent, Antigravity CLI, plus any local or remote OpenAI-compatible endpoint —
become tools any AI can call.

Six tools: `dispatch` starts routed work, `job_status` checks or lists it,
`cancel_job` stops one, `retry_job` runs a finished one again, `workspace`
inspects or keeps an isolated run's changes, and `usage` reads route and quota
state.

## Documentation

<!-- Absolute links on purpose: `docs/` is not in package.json's `files`, so a
     relative link is dead on npmjs.com — the same reason plugin/README.md is
     linked absolutely below. CHANGELOG.md IS shipped, so it stays relative. -->

| | |
|---|---|
| [Configuration](https://github.com/fstubner/harness-dispatch/blob/main/docs/configuration.md) | Adding a harness, endpoint modes, what `configure` writes |
| [MCP and HTTP surfaces](https://github.com/fstubner/harness-dispatch/blob/main/docs/interfaces.md) | The six tools, the REST endpoints, chaining delegated work |
| [Status and observability](https://github.com/fstubner/harness-dispatch/blob/main/docs/operations.md) | The status model, quota, and what leaves your machine |
| [CHANGELOG](CHANGELOG.md) | What changed, and what each fix missed |

## What it looks like

Your agent calls one tool:

```json
{
  "prompt": "Port the retry logic in src/net/ to the new backoff helper, then run the tests.",
  "workingDir": "/path/to/project",
  "hints": { "taskType": "execute" }
}
```

Quick tasks come straight back:

```json
{
  "mode": "single",
  "completed": true,
  "success": true,
  "route": "codex_cli",
  "model": "gpt-5.6-terra",
  "output": "Ported 4 call sites to withBackoff(); 118 tests pass.",
  "durationMs": 47210,
  "routing": { "tier": 1, "taskType": "execute", "reason": "tier 1 best (3 available)" }
}
```

Slow ones hand back a `jobId` after 25 seconds instead, and keep running:

```json
{ "mode": "single", "completed": false, "jobId": "job-1786977316001-b49d1232" }
```

Carry on working, then call `job_status` with that id for a live output tail or the
finished result. The run lives in a detached process, so **nothing is lost to a client
timeout — or to the server itself restarting mid-run.**

## What it does on your machine

Stated plainly, up front, rather than left to be inferred:

- It **spawns the CLIs above as subprocesses** with your prompts.
- Those CLIs **read and write files** under the `workingDir` you pass (that's the
  point of the tool) and **run shell commands**, depending on the workspace and
  safety policy in effect.
- At most **4 agent CLIs run at once**; extra dispatches queue and start as slots
  free. Tune with `max_concurrent_runs`.
- `serve` additionally binds a local HTTP port: loopback only by default,
  bearer-token gated. Read [the HTTP surface docs](https://github.com/fstubner/harness-dispatch/blob/main/docs/interfaces.md) before pointing `--host`
  anywhere else.

None of this is unusual for a coding-agent tool. It's here in one place so you can
decide before installing rather than after.


## Install

Needs Node.js `>=22.22.2` (so current LTS works) and at least one harness or endpoint.

`git` is optional but recommended: dispatch works without it, but the
`workspace` tool shells out to git to diff and apply an isolated run's changes,
and the `git_worktree` isolation policy needs it. `doctor` reports whether it
found one.

`doctor` checks your install, config, auth and routes without contacting any
provider. Add `--live` when you want it to prove a dispatch really works end to
end — that one sends a real request through an eligible route and spends
whatever quota that route bills against, so it is a deliberate step rather than
part of setup. `configure` is optional too: the tool auto-detects installed
harnesses and runs without a `config.yaml` at all. Write one when you want to
pin routes, add an endpoint, or change a default.

`configure --yes` detects installed harnesses, writes `config.yaml` into the
tool's own state directory (`~/.harness-dispatch/`, or `HARNESS_DISPATCH_STATE_DIR`)
— unless a `config.yaml` already exists in the current directory or
`HARNESS_DISPATCH_CONFIG` is set, in which case that file is the target.

Without `--yes` it previews and writes nothing.

**Registering with your MCP clients.** After writing, `configure` offers to
register this server with each client it finds (Claude Code, Cursor), showing
what it would write and what is already there before changing anything.
`--no-clients` skips the offer and prints a snippet to paste instead.
`harness-dispatch connect` does the same registration later on its own, and
`connect --remove` undoes it.

**Re-running it.** A file `configure` wrote and you have not edited is
regenerated, so installing a harness later is just `configure --yes` again. A
file you have changed is refused without `--force` — and because such a file
lists its own routes, even `--force` regenerates it from the file rather than
from a fresh detection. It says so when that happens; add `detect: true` to the
file to merge newly installed harnesses in.

**What `doctor` checks.** The whole chain: binary, config load, harness
detection, auth and billing classification, route readiness, whether
`dist/job-runner.js` is present (without it jobs run in-process and the
concurrency cap does not apply), and for a Codex route it asks `codex login
status` whether the CLI is logged in. The other harnesses have no equivalent
this tool has verified, so their login state is not checked. `--live` goes
further and routes one tiny real prompt through an eligible route, so you see a
completion before wiring anything into your agent — that one spends quota, and
it never touches paid or unknown-billing routes unless you pass `--allow-paid`.

Your Claude Code / Codex / Cursor subscriptions run by default with no opt-in;
`configure` tells you if anything is blocked and why.

No global install needed either: `npx harness-dispatch configure`.

### Plugin install (Claude Code / Claude Desktop / Codex)

The `plugin/` directory packages the MCP server plus a delegation skill and
`/route` + `/jobs` commands for one-step installs — see
[plugin/README.md](https://github.com/fstubner/harness-dispatch/blob/main/plugin/README.md)
(absolute link on purpose: `plugin/` is not shipped in the npm tarball, so a
relative link is dead on npmjs.com). Claude Code:
`/plugin marketplace add <repo path or URL>` then
`/plugin install harness-dispatch@harness-dispatch`. Codex:
`node plugin/scripts/install-codex.mjs`.

## Billing, and what it can't promise

**A configured harness runs automatically**, with nothing to switch on. Routes that
have no billing backstop at all, meaning a raw metered API key or billing it can't
classify, stay blocked until you set `allow_paid_usage: true` on them.

The honest limit: if a harness's account already has paid or overage billing switched
on at the **provider** (Cursor on-demand, Claude usage credits, Codex flexible
credits), harness-dispatch will spend that too. It cannot see or change provider-side
billing state. What it does is refuse routes where *no* provider-side ceiling exists
at all.

Run `status` (or `status --json`) for any route's billing classification; the `note:`
lines spell out the reasoning per route.

<details>
<summary>Renamed from <code>harness-router</code> — upgrade notes</summary>

The npm package, CLI command, env var prefix (`HARNESS_DISPATCH_*`), and MCP resource
URIs (`harness-dispatch://status`) all changed together. From an older install:
`npm uninstall -g harness-router && npm install -g harness-dispatch`, then update any
`mcpServers` / `claude_desktop_config.json` entry to invoke `harness-dispatch`.

Two packages predate the rename and are unmaintained: `harness-router` (`0.3.2`) and
the separately-published `harness-router-mcp` (`0.2.0`). Both lack `usage`,
`/v1/models`, `/v1/usage`, Antigravity support, and every fix described here.

`npx -y harness-dispatch`, the plugin's fallback launch path, resolves to whatever
is currently on the npm registry, which can lag a local clone's `dist/`. Check with
`npm ls -g harness-dispatch`.

</details>

## Safety profiles, and Cursor on Windows

A caller asks for one of three profiles, and each is a limit rather than a
capability:

| Profile | Means |
|---|---|
| `read_only` | Look, don't touch |
| `workspace_edit` | Edit files in the workspace, no arbitrary shell |
| `full_auto` | Edit files and run shell |

A route declares the floor it actually runs at (`effective_safety`), and is
skipped when that floor exceeds what was asked for. A route is never quietly
given more access than the caller requested.

`cursor_cli` is the interesting case, because its capability differs by mode:

- `read_only` uses `--mode plan`, which is genuinely read-only (verified: asked
  to create one file and overwrite another, it did neither).
- `full_auto` uses print mode, which edits and runs shell.
- `workspace_edit` is **skipped on Windows**. Cursor's print mode grants write
  and shell together, and `--sandbox enabled` — the flag that would constrain
  shell while allowing edits — is macOS/Linux only. There is no edit-without-shell
  mode to route to, so claiming that level would mean handing shell access to a
  caller who explicitly asked not to have it.

Cursor still edits code on Windows. Ask for `full_auto`.

### Overriding it

If you accept that Cursor's editing mode carries shell access and you want it
to serve `workspace_edit` anyway, declare the floor yourself in `config.yaml` —
your value replaces the shipped default:

```yaml
clis:
  - name: cursor_cli
    harness: cursor
    command: cursor-agent
    effective_safety:
      read_only: read_only
      workspace_edit: workspace_edit   # you are accepting shell access here
      full_auto: full_auto
```

That is a deliberate local decision, not a bug workaround: the shipped default
is conservative because the tool cannot verify what a given `cursor-agent`
build will do. On macOS and Linux the better route is `--sandbox enabled`,
which constrains shell for real — untested here, so it is not shipped on by
default.

## CLI

```bash
harness-dispatch configure        # detect harnesses and prepare config
harness-dispatch doctor           # validate install, auth, config and routes
harness-dispatch status           # route readiness, quota, breaker state
harness-dispatch usage            # per-route call counts and billing kind
harness-dispatch dispatch "..."   # route one task and print the result
harness-dispatch serve            # /mcp and /v1/* over local HTTP
```

Every command, its flags, and the hidden compatibility aliases are in
[MCP and HTTP surfaces](https://github.com/fstubner/harness-dispatch/blob/main/docs/interfaces.md#cli).

## Everything else

Route ids, protocol blocks and per-harness overrides live in
[Configuration](https://github.com/fstubner/harness-dispatch/blob/main/docs/configuration.md). The tool and endpoint reference is in
[MCP and HTTP surfaces](https://github.com/fstubner/harness-dispatch/blob/main/docs/interfaces.md). Quota, breaker state and telemetry
are in [Status and observability](https://github.com/fstubner/harness-dispatch/blob/main/docs/operations.md).

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
