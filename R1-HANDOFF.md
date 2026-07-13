# R1 Port Handoff — Python → TypeScript

This document hands off the R1 milestone from the plan at
`C:\Users\Felix\.claude\plans\nested-churning-firefly.md` (Phase 1 / R1).

## State entering this checklist

- Folder renamed `coding-router-mcp` → `coding-agent-mcp`.
- Python implementation preserved on branch `archive/python-v1` and tag
  `python-v1-final` (both pushed to origin).
- `src/` cleared except for a stub `src/index.ts`.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` scaffolded
  for TypeScript.
- Config files (`config.yaml`, `config.example.yaml`, `.env.sample`),
  `data/coding_benchmarks.json`, `CLAUDE.md`, `README.md`, and Python helper
  `scripts/` remain untouched so the port has reference material.
- No TypeScript source beyond the stub. No tests.

## R1 exit criteria (from plan)

1. Scoring output byte-identical to Python for the fixture set.
2. Library face importable: `import { Router } from "coding-agent-mcp"`.
3. CLI demo works: `tsx src/bin.ts route "fix bug X"` prints chosen dispatcher
   and streams output.

## Files to port (in this order)

Reference Python paths are relative to the pre-port archive branch
(`git show archive/python-v1:<path>`).

### Step 1 — Types and contracts
`src/types.ts`
- From: `src/coding_agent/dispatchers/base.py` (`DispatchResult`, `QuotaInfo`) +
  `src/coding_agent/router.py` (`RoutingDecision`) + `src/coding_agent/config.py` (`ServiceConfig`, `RouterConfig`).
- Keep field names exact. Represent unions (`"execute" | "plan" | "review" | "local" | ""`) as string literal unions.
- Add `DispatcherEvent` discriminated union for future streaming
  (types: `stdout`, `stderr`, `tool_use`, `thinking`, `completion`, `error`) —
  not wired up in R1 dispatchers but the type exists so R3 can slot in.

### Step 2 — Circuit breaker
`src/circuit-breaker.ts`
- Direct port of `CircuitBreaker` class from `router.py:67-115`.
- Preserve constants: `THRESHOLD = 5`, `DEFAULT_COOLDOWN = 300`.
- Use `performance.now()` for monotonic time (not `Date.now()`).
- Public surface: `isTripped`, `recordFailure(retryAfter?)`, `recordSuccess()`,
  `trip(retryAfter?)`, `cooldownRemaining()`, `status()`.

### Step 3 — Leaderboard
`src/leaderboard.ts`
- Port `LeaderboardCache` from `src/coding_agent/leaderboard.py`.
- Constants (these are scoring-critical — do not change):
  - `LEADERBOARD_URL` = `https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code`
  - `BENCHMARK_FILE` = `<repoRoot>/data/coding_benchmarks.json` (see
    `_BENCHMARK_FILE` resolution in Python — TS needs to resolve from the
    package root, not `import.meta.url` directly; use `fileURLToPath` + walk up).
  - `CACHE_TTL` = 24 × 3600 seconds
  - `TIER1_ELO_MIN` = 1350, `TIER2_ELO_MIN` = 1200, `THINKING_THRESHOLD_BOOST` = 25
  - `THINKING_MULTIPLIERS` = { high: 1.15, medium: 1.07, low: 1.0 }
  - `ELO_NORM_MIN` = 1000, `ELO_NORM_MAX` = 1600
  - `QUALITY_MIN` = 0.60, `QUALITY_MAX` = 1.00, `QUALITY_DEFAULT` = 0.85
- Async mutex: TS doesn't have a built-in; use a promise-chain or a tiny helper
  (one in-flight fetch at a time). Do NOT use `async-mutex` — keep zero runtime deps here.
- HTTP: use global `fetch` (Node 24 built-in). Send `User-Agent` header —
  the API returns 403 without it. Preserve the exact UA string:
  `coding-agent-mcp/1.0 (leaderboard quality scoring)`.
- Fuzzy match (`_fuzzy_match` in Python) — three-tier fallback:
  1. Exact case-insensitive
  2. Query is substring of leaderboard name → shortest match wins
  3. All query words appear in name → shortest match wins
- `normalizeElo`, `getQualityScore`, `autoTier` must produce identical outputs
  to Python. Snapshot-test with fixture inputs.

### Step 4 — Quota
`src/quota.ts`
- Port `QuotaState` + `QuotaCache` from `src/coding_agent/quota.py`.
- `QuotaState.score` is a getter computed from `remaining / limit` or
  `(limit - used) / limit`, clamped `[0, 1]`, defaulting to `1.0` when unknown.
- `QuotaCache`:
  - Constructor takes `dispatchers` map, optional TTL (default 300s),
    optional state file path (default `quota_state.json`).
  - `getQuotaScore(service)` — triggers `_maybeRefresh` then returns state score.
  - `recordResult(service, result)` — updates `_localCounts`, writes async
    (in Node: `fs.promises.writeFile` without await = fire-and-forget).
  - `_maybeRefresh(service)` — calls `dispatcher.checkQuota()` with a 15s timeout.
  - Rate-limit header parsing moves to `src/dispatchers/shared/rate-limit-headers.ts`.

### Step 5 — Shared dispatcher utilities
`src/dispatchers/shared/subprocess.ts`
- From `src/coding_agent/dispatchers/utils.py` (async subprocess runner).
- Use `node:child_process` `spawn`. Capture stdout/stderr as strings;
  return `{ stdout, stderr, exitCode, durationMs }`.
- Respect file-size limits and timeout (default 5 min per call).

`src/dispatchers/shared/windows-cmd.ts`
- From `utils.py:14-31` (Windows `.cmd`/`.bat` detection and wrapping).
- Test on Windows. Behaviour: if `process.platform === "win32"` and the
  resolved CLI path ends in `.cmd` or `.bat`, wrap with `cmd /c`. Otherwise
  pass through. `which` package resolves the binary.

`src/dispatchers/shared/rate-limit-headers.ts`
- From `utils.py` (`parse_remaining`, `parse_limit`, `parse_retry_after`).
- Case-insensitive header name matching. Handle both numeric values and
  HTTP-date strings for `Retry-After`.

### Step 6 — Dispatcher base
`src/dispatchers/base.ts`
- Abstract class / interface mirroring `BaseDispatcher` in Python.
- `dispatch(prompt, files, workingDir, opts?) → Promise<DispatchResult>`
- `checkQuota() → Promise<QuotaInfo>` (default returns `{ source: "unknown" }`)
- `isAvailable() → boolean` (default `true`)
- Streaming-ready: second method `stream(prompt, files, workingDir, opts?) → AsyncIterable<DispatcherEvent>` whose default implementation calls `dispatch()` and yields a single completion event. R3 replaces per-dispatcher.

### Step 7 — Claude Code dispatcher
`src/dispatchers/claude-code.ts`
- Port from `src/coding_agent/dispatchers/claude_code.py`.
- Command: `claude -p "<prompt>" --output-format json --allowedTools "Bash,Read,Edit,Write" --permission-mode acceptEdits [--model <override>]`
- Auth via Claude Code OAuth (no API key flag).
- Parse the JSON output for token usage + text content.
- Support `modelOverride` in `dispatch` opts for escalation.

### Step 8 — Codex dispatcher
`src/dispatchers/codex.ts`
- Port from `src/coding_agent/dispatchers/codex.py`.
- Command: `codex exec "<prompt>" --full-auto --json [--model <model>] [--cd <dir>]`
- Reads `OPENAI_API_KEY` from env.

### Step 9 — Router
`src/router.ts`
- Port `Router` + `RoutingDecision` + `pickService` + `route` + `routeTo`
  from `src/coding_agent/router.py`.
- **SCORING MATH IS LOAD-BEARING** — port `router.py:265-280` exactly:
  ```
  effectiveQuality = qualityScore * cliCapability * capScore
  score = effectiveQuality * quotaScore * svc.weight
  if (preferLargeContext && harness in ["gemini", "gemini_cli"]) score += 0.3
  if (taskType === "local" && svc.type === "openai_compatible" &&
      svc.baseUrl?.includes("localhost")) score += 0.3
  ```
- Tier selection:
  1. Build `tierCandidates: Map<number, Candidate[]>`.
  2. If `svc.leaderboardModel`, call `leaderboard.autoTier(...)`, else use `svc.tier`.
  3. Sort tiers ascending; within each tier sort candidates by score descending.
  4. Return first candidate of lowest tier that has any candidates.
  5. If `tier > minConfiguredTier`, reason includes "fallback".
- Model escalation: if `svc.escalateModel && svc.escalateOn.includes(taskType)`,
  use `svc.escalateModel`, else `svc.model`.
- Fallback on transient failure (non-rate-limited): exclude failed service,
  retry up to `maxFallbacks = 2` additional attempts.

### Step 10 — Config loader
`src/config.ts`
- Port `src/coding_agent/config.py`.
- `loadConfig(path?: string): RouterConfig`
  - Auto-detect mode (no config path given):
    - Probe `PATH` via `which` for `claude`, `agent`, `codex`, `gemini`.
    - Apply hardcoded defaults per detected CLI (mirror Python's built-in table).
  - Explicit mode (path given):
    - Read YAML via `js-yaml`. If file has `services:` key, use as-is.
    - Otherwise apply auto-detect defaults and merge `overrides` on top.
  - Env var interpolation: `${ENV_VAR}` syntax in any string field.
- `watchConfig(path, onChange): { stop() }` — mtime-based poll (1s interval
  is fine) that calls `onChange` when the file changes.

### Step 11 — CLI entry
`src/bin.ts`
```ts
#!/usr/bin/env node
// R1 minimum: `tsx src/bin.ts route "<prompt>"` streams output using the
// auto-selected best service.
// R2 will replace this with the full MCP server.
```
- Parse argv (Node 24 `util.parseArgs`).
- Subcommands: `route <prompt>`, `list-services`, `dashboard`.
- Consume the streaming interface added in Step 6.

### Step 12 — Library export surface
Update `src/index.ts` to re-export:
```ts
export { Router } from "./router.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export { QuotaCache, QuotaState } from "./quota.js";
export { LeaderboardCache } from "./leaderboard.js";
export { loadConfig, watchConfig } from "./config.js";
export * from "./types.js";
```

## Tests to write

### `tests/circuit-breaker.test.ts`
- Fresh breaker: not tripped, 0 failures.
- Five failures → tripped. Status reports `tripped: true`.
- Cooldown expires → `isTripped` returns false, failures reset.
- `trip(retryAfter)` honours provided cooldown.
- `Retry-After` header via `recordFailure(retryAfter)` sets cooldown.

### `tests/leaderboard.test.ts`
- `normalizeElo`: 1000 → 0.60, 1600 → 1.00, 1300 → 0.80 (midpoint).
- `getQualityScore` with known benchmark model: returns benchmark value × thinking mult.
- `getQualityScore` with unknown model: returns 0.85 × thinking mult.
- `autoTier` thresholds: 1350 → tier 1; 1200 → tier 2; 1199 → tier 3;
  with `thinking=high` boost: 1325 → tier 1.
- Fuzzy match: exact, substring, all-words-present.
- Mock `fetch` for Arena API; never hit real network.

### `tests/quota.test.ts`
- `QuotaState.score`: `remaining/limit`, fallback `(limit-used)/limit`, default 1.0.
- `recordResult` with rate-limit headers updates state.
- `_maybeRefresh` respects TTL (no double-fetch within window).
- Local-counts persistence round-trip.

### `tests/scoring-parity.test.ts`
- The exit-criterion test. Table-driven.
- Each row: `{ services, hints, expectedServiceName, expectedScore }`.
- Derive fixtures from Python by running the old `smoke_test.py` with
  extra logging, or by deriving by-hand for a few canonical cases
  (e.g. "two tier-1 services, different ELO, same task_type" →
  higher-ELO wins deterministically).
- At minimum: five fixture rows covering forced-service, tier-1 pick,
  tier-2 fallback, prefer-large-context boost, local boost.

### `tests/windows-cmd.test.ts`
- On non-Windows: pass-through (no wrapping).
- On Windows (mocked `process.platform`): `.cmd` → wrapped in `cmd /c`,
  `.exe` → pass-through.
- Covers the edge case of a path containing spaces.

## Definition of done (R1)

- [ ] All files above exist and compile (`pnpm typecheck`).
- [ ] All tests pass on Linux (`pnpm test`).
- [ ] Scoring-parity test passes against stored Python fixtures.
- [ ] `pnpm dev -- route "hello"` runs and picks a service (falls back gracefully
  if no authenticated CLI is available — prints the reason, exits 0).
- [ ] `import { Router } from "coding-agent-mcp"` in a scratch TS file compiles
  and instantiates without error (smoke).
- [ ] Commit with message: `feat: R1 TypeScript port of router core (core + 2 dispatchers + CLI)`

## Deferred to R2 / R3 (do NOT build in R1)

- R2: Cursor, Gemini, OpenAI-compatible dispatchers. MCP stdio + streamable-HTTP
  transports. Tool registration (`code_auto`, `code_mixture`, etc.).
- R3: Full `AsyncIterable<DispatcherEvent>` across library + MCP. OTel
  instrumentation. Live `dashboard` tool.

## Notes / gotchas

- Node 24 is the target. Avoid dependencies that require older Node APIs.
- Windows CI matters — the `cmd /c` wrapping is the most likely regression.
  Test on Windows before marking R1 done.
- Do NOT commit `quota_state.json` or `test_state.json` — already in `.gitignore`.
- The existing `config.yaml` at the repo root is the user's live config.
  Do not modify it. `config.example.yaml` is the published example.
- `data/coding_benchmarks.json` is the blended benchmark file. Preserve as-is.
  The TS loader reads it from the package root at runtime.
