# harness-dispatch

[![npm](https://img.shields.io/npm/v/harness-dispatch?logo=npm)](https://www.npmjs.com/package/harness-dispatch)
[![CI](https://github.com/fstubner/harness-dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/fstubner/harness-dispatch/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/harness-dispatch)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/harness-dispatch)](LICENSE)

**Let your AI coding agent hand bounded tasks to the other agent CLIs you already have.**

harness-dispatch is a local MCP server. Your main agent (Claude Code, Cursor, Codex,
or any MCP client) calls one tool, `dispatch`, and the task runs in another coding
agent: Claude Code, Codex, Cursor Agent, Antigravity (opt-in, see
[vendor terms](https://github.com/fstubner/harness-dispatch/blob/main/docs/configuration.md#vendor-terms)),
or a local model. It runs as a background job, so a long task does not time out and
survives a client restart. If the route that would run it is rate-limited or busy,
the task goes to the next one.

It is for a developer who uses one AI coding agent and wants it to hand off reviews,
refactors, second opinions and parallel work to the others, without pasting prompts
between tools.

A **harness** here is a coding-agent command-line tool such as `claude`, `codex`,
`cursor-agent` or `agy`. harness-dispatch runs the real tool under your own login;
it does not re-implement it, proxy its API or read its credentials.

## Install

You need Node.js `>=22.22.2` and at least one harness installed and logged in. An
OpenAI-compatible endpoint (a local model, say) also works, but it can only plan and
review: it has no file access.

```bash
npm install -g harness-dispatch
harness-dispatch configure --yes
harness-dispatch connect
harness-dispatch doctor
```

`connect` registers the server with Claude Code and/or Cursor; restart the client
afterwards. `doctor` ends with a one-line verdict, and a `warn` row names what is
still worth doing. No global install needed either: `npx harness-dispatch configure`.

## What it does on your machine

- It **spawns the harnesses as subprocesses** with your prompts.
- Those harnesses **read and write files** under the `workingDir` you pass (that is the
  point of the tool) and **run shell commands**, depending on the safety and workspace
  policy in effect.
- At most **4 agent CLIs run at once** (`max_concurrent_runs`); extra dispatches queue
  ([concurrency](https://github.com/fstubner/harness-dispatch/blob/main/docs/operations.md#concurrency)).
- `serve` additionally binds a local HTTP port: loopback only by default, bearer-token
  gated. Read [the HTTP surface docs](https://github.com/fstubner/harness-dispatch/blob/main/docs/interfaces.md) before pointing `--host`
  anywhere else.
- The default install makes no network call of its own. Prompts go only to the harnesses
  and endpoints you configured.

Six MCP tools: `dispatch` starts routed work, `job_status` checks or lists it,
`cancel_job` stops one, `retry_job` runs a finished one again, `workspace` inspects or
keeps an isolated run's changes, and `usage` reads route and quota state. It speaks MCP
2026-07-28 and the older revisions clients still ask for
([protocol revisions](https://github.com/fstubner/harness-dispatch/blob/main/docs/interfaces.md#protocol-revisions)).

## Documentation

<!-- Absolute links on purpose: `docs/` is not in package.json's `files`, so a
     relative link is dead on npmjs.com. It's the same reason plugin/README.md is
     linked absolutely below. CHANGELOG.md IS shipped, so it stays relative. -->

| | |
|---|---|
| [Configuration](https://github.com/fstubner/harness-dispatch/blob/main/docs/configuration.md) | Adding a harness, endpoint modes, what `configure` writes |
| [MCP and HTTP surfaces](https://github.com/fstubner/harness-dispatch/blob/main/docs/interfaces.md) | The six tools, the REST endpoints, chaining delegated work |
| [Operating it](https://github.com/fstubner/harness-dispatch/blob/main/docs/operations.md) | Failure modes and recovery, the status model, and what leaves your machine |
| [CHANGELOG](CHANGELOG.md) | What changed, and what each fix missed |

## What it looks like

Your agent calls one tool:

```json
{
  "prompt": "Rename the retry helper in src/net/ to withBackoff.",
  "workingDir": "/path/to/project",
  "hints": { "taskType": "execute", "modelTier": "cheap" }
}
```

`modelTier` (`cheap`, `standard` or `strong`) asks for a strength of model, not a
named one: the router picks the route, and that route runs its own model for the tier.

A task that finishes within the wait (25 seconds by default, `graceSeconds`) comes
straight back:

```json
{
  "mode": "single",
  "completed": true,
  "success": true,
  "route": "codex_cli",
  "model": "gpt-5.6-terra",
  "output": "Renamed it and updated 4 call sites.",
  "durationMs": 18240,
  "routing": { "tier": 1, "taskType": "execute", "reason": "tier 1 best (3 available)" }
}
```

Real agent work usually runs longer than that, so the reply you will see most is a
`jobId`, with the job still running:

```json
{ "mode": "single", "completed": false, "jobId": "job-1786977316001-b49d1232" }
```

Carry on working, then call `job_status` with that id for a live output tail or the
finished result. The run lives in a detached process, so **nothing is lost to a client
timeout, or to the server itself restarting mid-run**. If the process running a job
dies, the job is reported `orphaned` rather than lost. On Windows, `doctor` checks
that the run really outlives a launcher that kills its children; see
[A run outlives its server](https://github.com/fstubner/harness-dispatch/blob/main/docs/operations.md#a-run-outlives-its-server).

## Setup details

`git` is optional but recommended: dispatch works without it, but the
`workspace` tool shells out to git to diff and apply an isolated run's changes,
and the `git_worktree` isolation policy needs it. `doctor` reports whether it
found one.

`doctor` checks your install, config, auth and routes without contacting any
provider. Add `--live` when you want it to prove a dispatch really works end to
end. That one sends a real request through an eligible route and spends
whatever quota that route bills against, so it is a deliberate step rather than
part of setup. `configure` is optional for dispatching: the tool auto-detects
installed harnesses and runs without a `config.yaml` at all. Write one when you
want to pin routes, add an endpoint, or change a default, or to use `connect`,
which registers clients against a config file and refuses to point them at one
that does not exist.

`configure --yes` detects installed harnesses, writes `config.yaml` into the
tool's own state directory (`~/.harness-dispatch/`, or `HARNESS_DISPATCH_STATE_DIR`),
unless `--config` names a file or `HARNESS_DISPATCH_CONFIG` is set, in which
case that file is the target. A `config.yaml` in the current directory is never
picked up on its own: a repository can carry one, and the config decides what
commands run, so a project config is opted into with `--config ./config.yaml`.

Without `--yes` it previews and writes nothing.

**Registering with your MCP clients.** After writing, `configure` offers to
register this server with each client it finds (Claude Code, Cursor), showing
what it would write and what is already there before changing anything.
`--no-clients` skips the offer and prints a snippet to paste instead.
`harness-dispatch connect` does the same registration later on its own (it
needs the config file to exist; `--yes` skips its confirmation for scripted
use), and `connect --remove` undoes it.

**Re-running it.** A file `configure` wrote and you have not edited is
regenerated, so installing a harness later is just `configure --yes` again. A
file you have changed is refused without `--force`. Because such a file
lists its own routes, even `--force` regenerates it from the file rather than
from a fresh detection. It says so when that happens; the rule behind it is
[listing a route turns detection off](https://github.com/fstubner/harness-dispatch/blob/main/docs/configuration.md#listing-a-route-turns-detection-off).

**What `doctor` checks.** The whole chain: binary, config load, harness
detection, auth and billing classification, route readiness, whether
`dist/job-runner.js` is present (without it jobs run in-process and the
concurrency cap does not apply) and that a background process started the way jobs
are started outlives its parent (on Windows, behind the launcher the MCP server runs
under), and for a Codex route it asks `codex login
status` whether the CLI is logged in. The other harnesses have no equivalent
this tool has verified, so their login state is not checked. `--live` goes
further and routes one tiny real prompt through an eligible route, so you see a
completion before wiring anything into your agent. That one spends quota, and
it never touches paid or unknown-billing routes unless you pass `--allow-paid`.

Each row is `ok`, `warn` (passes, exit 0, but wants something done: a client not yet
registered, `git` missing, a route that has never succeeded) or `fail` (exit 1). The
last line is the verdict.

Your Claude Code / Codex / Cursor subscriptions run by default with no opt-in;
`configure` tells you if anything is blocked and why.

### Plugin install (Claude Code / Claude Desktop / Codex)

The `plugin/` directory packages the MCP server plus a delegation skill and
`/setup`, `/route` and `/jobs` commands for one-step installs. See
[plugin/README.md](https://github.com/fstubner/harness-dispatch/blob/main/plugin/README.md)
(absolute link on purpose: `plugin/` is not shipped in the npm tarball, so a
relative link is dead on npmjs.com). Claude Code:
`/plugin marketplace add <repo path or URL>` then
`/plugin install harness-dispatch@harness-dispatch`. Codex:
`node plugin/scripts/install-codex.mjs`.

### Where to put the instructions that tell an agent to delegate

In your user-level file (`~/.claude/CLAUDE.md`, or the equivalent for your
client), not in a project file that gets committed.

Two reasons, and the second bites even among people who all run this tool:

- A teammate without it reads instructions for tools their agent does not have.
- **Route ids do not travel.** `codex_cli`, `local_inference` and the rest are
  whatever *your* config declares. Someone else's install has different ones, so
  a committed `service:` or model name is wrong for them rather than merely
  unused. Ask for a strength of model instead with `hints.modelTier` (`cheap`,
  `standard` or `strong`): any install can resolve that, and the router still
  picks the route and falls back when one is busy.

A project's checked-in `CLAUDE.md` is for the codebase: how it builds, how it is
tested, its conventions. Personal-but-project-specific notes go in
`CLAUDE.local.md`, which is gitignored by convention.

If a team does want a shared mention, keep it short and free of route ids, so it
costs nothing to anyone who has not installed this. The [AGENTS.md](AGENTS.md) in
this repository (which its `CLAUDE.md` imports) is written that way on purpose.

Nothing here writes to a project file. `configure` and `connect` touch only
user-level client configs, and they show you the change before making it.

## Billing, and what it can't promise

**A configured harness runs automatically**, with nothing to switch on. Routes that
have no billing backstop at all, meaning a raw metered API key or billing it can't
classify, stay blocked until you set `allow_paid_usage: true` on them.

The honest limit: if a harness's account already has paid or overage billing switched
on at the **provider** (Cursor on-demand, Claude usage credits, Codex flexible
credits), harness-dispatch will spend that too. It cannot see or change provider-side
billing state. What it does is refuse routes where *no* provider-side ceiling exists
at all.

Run `status` (or `status --json`) for any route's billing classification. Where the
classification needs explaining (Claude Code's surfaces, a local endpoint whose billing
is unknown), a `note:` line under the route says why.

<details>
<summary>Renamed from <code>harness-router</code>: upgrade notes</summary>

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

## Safety profiles

A caller asks for one of three profiles: `read_only`, `workspace_edit` (the default)
or `full_auto`. Each is a limit, not a capability: a route is skipped rather than
given more access than was asked for. Cursor and Antigravity cannot offer
`workspace_edit`, so ask for `full_auto` there. What each profile means, how each
harness enforces it, and how to override the floor are in the
[configuration guide](https://github.com/fstubner/harness-dispatch/blob/main/docs/configuration.md#safety-profiles-and-cursor).

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
are in [Operating it](https://github.com/fstubner/harness-dispatch/blob/main/docs/operations.md).

## Contributing and security

Build, test and pull request notes are in
[CONTRIBUTING.md](https://github.com/fstubner/harness-dispatch/blob/main/CONTRIBUTING.md).
To report a vulnerability, use the private route in
[SECURITY.md](https://github.com/fstubner/harness-dispatch/blob/main/SECURITY.md).
