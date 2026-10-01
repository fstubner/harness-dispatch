# ARCHITECTURE

## Shape

One npm package, three entry points into the same core, plus one process type
it spawns.

| Part | Entry | Runs as |
|---|---|---|
| MCP server (stdio) | `bin.ts` (default) | Child of the calling agent |
| HTTP server | `bin.ts serve` -> `http/server.ts` | Long-lived local server |
| CLI | `bin.ts status \| doctor \| configure \| usage \| auth`, each command in `cli/` | One-shot |
| Job supervisor | `job-runner.ts --supervisor` | Detached, spawned by the above |

All four share `router.ts` and the config in `config.ts`. There is no server
the user does not run themselves, and no shared multi-tenant state.

## Core flow

```
caller -> mcp/server.ts (dispatch tool)
            -> jobs.ts        create job dir, prompt.md, manifest
            -> drainSlotQueue release within max_concurrent_runs, FIFO
            -> spawn supervisor pool (<= 4 processes)
                 -> router.ts   score routes, pick one
                      -> workspaces.ts   apply workspace_policy
                      -> dispatchers/*   spawn the harness CLI / call the endpoint
                 -> result.json in the job dir
```

The MCP call waits a grace window and returns either the finished result or a
`jobId`. **The job directory on disk is the source of truth**, not process
memory — which is what makes a dispatch survive an MCP timeout or a server
restart (the run is a detached process, not a child of the server), and what
keeps the record of a run whose own process died, which is then reported
`orphaned` rather than lost. On Windows a plain detached spawn is not enough: a
launcher that puts its child in a job object that kills everything in it when
the session ends (the nvx shim does) takes a detached run with it. The
supervisor (the detached process that runs the jobs) is therefore launched through WMI
(`Win32_Process.Create`, via PowerShell), which belongs to none of the
caller's job objects (`src/jobs/detach.ts`); where WMI or PowerShell is
unavailable it falls back to the plain spawn, notes that in the spawn log, and
a run launched that way does not survive such a launcher. `doctor` runs a real
probe through the same launch and fails if the probe dies with its parent.
POSIX uses the plain detached spawn (setsid).

## Parts and boundaries

**`config.ts`** — the only place that reads user config or shipped harness
defaults. Everything downstream consumes `RouterConfig`. Note it is the widest
file in the codebase and the one where silently-dropped keys have hidden
(`workspace_policy` on `clis:` was parsed for two of three route shapes).

**`router.ts`** — scoring and selection. Score is
`cliCapability x capScore x quotaScore x weight` within a tier (tier first, then
score; there is no benchmark term), filtered by
availability, breaker state, safety compatibility, and billing policy.
Deliberately has no harness-specific branches; harness behaviour lives in
config, not code.

**`dispatchers/`** — two implementations only: `generic-cli.ts` (every CLI
harness, driven entirely by `protocol` in config) and `openai-compatible.ts`
(HTTP endpoints). A new harness needs config, not TypeScript.

**`workspaces.ts` + `workspace-lock.ts`** — what a delegate can touch.
`shared`, `shared_locked` (cross-process mutex), `copy`, `git_worktree`.

**`safety.ts`** — profiles as *limits*. A route declares the floor it actually
runs at; a request asking for less than that floor is refused, never quietly
upgraded.

**`billing.ts` + `route-policy.ts`** — classification and gating. Unknown
billing is treated as paid.

**`quota.ts`, `circuit-breaker.ts`, `breaker-store.ts`** — reactive state.
Breaker state is per-route files (one shared blob lost 75% of concurrent
writes); quota counters are informational only and never feed routing.

## Boundaries

1. **Caller -> MCP surface.** The calling agent may be steered by injected
   content, so inputs are validated at the boundary: `jobId` format (and again
   in `jobs.ts`), `files` count, safety enums. Not "the caller is trusted".
2. **Dispatcher -> harness process.** The child inherits `process.env` minus
   every other route's API key. Its working directory is governed by
   `workspace_policy`.
3. **Harness output -> orchestrator.** Delegate output is data. Where it is
   passed to another delegate (`contextJobs`), it is explicitly framed as work
   to build on, not instructions.
4. **HTTP surface.** Bearer token, bound to loopback by default.

## Trust

What this system assumes, and what it refuses to assume:

- **The calling agent is not trusted to be well-behaved.** It may be steered by
  content it read. Every MCP input is validated at the boundary.
- **Harness output is not trusted as instruction.** It is data, including when
  it is forwarded to another delegate via `contextJobs`.
- **The operator is trusted** — config is authored by the person running the
  tool, so config values are validated for correctness, not for malice. The one
  exception is anything reaching a filesystem path, which is escaped regardless.
- **Providers are not trusted to be correct.** A malformed rate-limit header is
  clamped rather than believed; unknown billing is treated as paid.
- **The local filesystem is trusted, the network is not.** The default install
  makes no outbound call at all.

## Concurrency model

- `max_concurrent_runs` bounds agent CLIs machine-wide. The binding constraint
  is **memory, not cores** — agent CLIs are heavyweight processes.
- Supervision is a pool of at most 4 supervisor processes. Each claims jobs up
  to its share of `max_concurrent_runs` (`ceil(limit / 4)`), so at the default
  of 4 each runs exactly one job and there is a supervisor per running job;
  supervisors only run several jobs each once the limit exceeds the pool (for
  example `max_concurrent_runs: 0`, which lifts the cap).
- Cross-process coordination is on disk: job status files, breaker files,
  workspace lock files, supervisor registrations. They do **not** share one
  liveness rule. Jobs and workspace locks use a heartbeat plus a pid check and
  a 30-second observe window; supervisors use heartbeat age alone; the
  `file-lock` guarding breaker, quota and log files uses lock age alone, with
  no heartbeat.

## Deliberate choices worth knowing

**Config-driven harnesses.** Adding a CLI is a YAML entry. The cost is that
`config.ts` carries the complexity, and parsing bugs there are invisible ones.

**Disk as IPC.** No daemon, no socket, no message bus. Slower and chattier than
shared memory, and a dispatch's record and queue position survive every process
dying: the next process reports what happened to a run whose own process is gone
(`orphaned`, retryable with `retry_job`) and does not resume it on its own.

**Failing closed.** An unresolvable command, an unrecognised safety enum, a
lock that cannot be acquired — each stops the route rather than proceeding
optimistically.

**Informational vs load-bearing state.** Quota counters accept a documented
read-modify-write race because nothing routes on them. Breaker state does not,
because it gates routing. Same file pattern, different guarantees, on purpose.
