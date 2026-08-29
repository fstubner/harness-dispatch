# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) and is
pre-1.0, so minor versions can carry behaviour changes.

## [Unreleased]

### Added

- The dispatch log records `candidates` — what the picked route beat — so the
  question the field was added to answer can be asked of a month of history
  rather than one response. It recorded `reason` ("tier 1 best (3 available)")
  and never what the choice was between, so the log could show the router had
  been used and not whether it chose well.
- `doctor` fails when an MCP client on this machine is configured to launch
  this server from a path that does not exist.

  That failure is invisible from both ends: a client which cannot spawn its
  server simply has no tools, which looks exactly like never having installed
  one, and the server never runs so it cannot complain. On the maintainer's
  machine Claude Code spent months launching a `dist/bin.js` under a directory
  that had been renamed away, alongside a session hook pointing at the same
  dead path. Neither said anything, and the tool had no way to notice because
  nothing looked.

  Read-only — it inspects Claude Code's and Cursor's config and never writes to
  them. Not being registered with any client is fine and reported as such; only
  a path that is genuinely absent fails. A bare command like `npx` is not
  checked, because resolving it means replicating PATH and shim lookup, and
  getting that wrong would report working installs as broken.

- `harness-dispatch dispatch "<prompt>"` — one routed task from the command
  line, with `--service`, `--safety`, `--task-type`, `--no-fallback` and
  `--json`. `route` still works; it is the same command under the name the MCP
  tool already uses.

  It existed as `route` and had no flags, which made it unusable for the job it
  is most needed for: an acceptance pass has to exercise the build in the
  working tree, and the MCP tool runs in whatever server process is already
  connected — a different artifact from a different moment. Meanwhile `route`
  hardcoded `execute` with two fallbacks, so asking for one read-only call on
  one route could get an execute-profile run on up to three. A typo'd
  `--safety` is refused by name rather than dropped to a default, which would
  hand the delegate more access than was asked for.

### Changed

- Cursor dispatches send the prompt on STDIN too — the route the ceiling
  actually broke. It is a `cursor-agent.CMD` wrapper, so cmd.exe caps its
  command line, and a 9,031-character prompt once died with the bare "The
  command line is too long." that the check exists to replace. A
  13,554-character prompt now dispatches and answers. Antigravity stays on argv:
  `agy --print` requires an inline argument and its only stdin path needs a
  different output parser, so the length machinery still has one route to
  protect.
- Claude Code dispatches send the prompt on STDIN instead of in the command
  line. Every command-line defect this project has fixed — replicating
  cross-spawn escaping, the 8,191-character cmd.exe ceiling, the npm-shim
  double-escape, a refusal band that was too tight and then too loose — applies
  only to routes that pass the prompt as an argument, and this was one of three
  that did. Codex has always used stdin. A 21,670-character prompt, 2.7x the
  ceiling and refused outright by the old form, now dispatches and answers.

### Fixed

- Workspaces belonging to projects that never dispatch again are reclaimed.
  Retention only ever swept inside one project's own directory, and only when
  that project dispatched again — so a project renamed, deleted, or created as
  a throwaway temp directory kept its workspaces forever, because the code that
  would reclaim them was reachable only from a project that no longer existed.
  Measured on the maintainer's machine: 840 project directories, 839 of them
  still holding runs five days past a 24-hour window. This project has already
  lost a disk to leaked scratch directories once.

  Conservative by construction: a project directory is removed only when every
  run inside it is past retention, never the caller's own, and never one
  holding a git worktree — those need git's own removal, which only the owning
  repository can do.

- `taskType: "local"` now actually reaches a local endpoint. It could not: the
  preference was a score bonus, a bonus only reorders routes within a tier, and
  local endpoints sit in the cheap tier — so any healthy top-tier route won
  before the bonus was ever consulted. Measured on a real config, every task
  type including `local` resolved to the same top-tier CLI, and a configured
  local box had zero calls in a month. It is a cross-tier selection rule now,
  and the only one: tier gating still stops plan and review work drifting onto
  a weaker route, because those task types are about capability and this one is
  explicitly not.
- "Local" means one thing again, and it is what a route DECLARES — provider,
  surface, auth source, billing kind — exactly as `routePolicy: "local_only"`
  has always decided it. `taskType: "local"` used its own narrower test of a
  loopback URL, so a real box on a LAN or tailnet address was local enough to
  be the only thing `local_only` would run, and not local enough for the task
  type named after it.

  A URL shape no longer overrides a declaration. Briefly it did both, and that
  was worse: a metered proxy on 127.0.0.1 — LiteLLM, OpenRouter, anything
  fronting a paid API — declares itself metered, and the loopback check
  overruled it, so the one task type meaning "free local endpoint" preferred
  the PAID route over a free subscription CLI. Nothing was lost by removing it:
  a local box that declares the fields is already covered, one declaring
  nothing on a known runtime port is inferred local from the port, and one on
  any other port never reaches candidacy at all.

## [0.7.9] — 2026-08-28

**Upgrade from 0.7.8.** Fixes found by using the thing: two from the release
pass 0.7.8 shipped with as open, the rest from reading a month of real
dispatch logs.

### Added

- `routing.candidates` — what the picked route beat, and by how much, best
  first. `reason` counted the alternatives ("tier 1 best (3 available)") and
  never named them, so the one question anyone has about an automatic choice
  went unanswered. Measured over a month of real dispatch logs: 85% of live
  dispatches named a route outright and the scoring ran on about one dispatch
  in seven. An unauditable chooser does not get used.
- `--version` / `-v`. It exited 1 with "unknown option", which reads like the
  binary is broken rather than like the flag is missing. Answered before config
  loading, because a version is what you ask for when something is already
  wrong.
- `doctor` reports whether `git` is on PATH, without failing over it — a
  machine without git is supported, so it must not change the exit code.
  Dispatch never needed it, but the
  `workspace` tool shells out to git to diff and apply an isolated run's
  changes — so without it a delegate's work COMPLETED and the tool that
  retrieves it died with `spawn git ENOENT`, naming a program the README never
  said you needed. Reported at setup, not a hard failure: the response carries
  `workspaceRoot`, so the changes are recoverable by hand.

### Fixed

- A harness that streams and then stops now says so, instead of handing back its
  own output as the error. Found in a month of real dispatch logs: nine Codex
  failures on one day recorded ~300 characters of raw JSONL — truncated
  mid-sentence — as the caller's only explanation, after waits of 11 to 88
  seconds. The message now names what happened (how many events streamed, the
  last one, the exit code) and says plainly that the output is not an error
  message and there was no result to return.

  Deliberately NOT a new event rule for the nested error frame those streams
  carry, which is the obvious-looking fix: a structured error overrides the
  exit code, so the benign notice in that frame ("Codex can still see every
  skill") would mark HEALTHY runs failed, charge the route and move the
  breaker. A test pins that negative.
- The plugin manifest claimed version 0.4.0 while bundling the 0.7.x server.
  Last touched at the rename and never bumped through three minor versions —
  and unlike `package.json`, which the publish workflow rewrites at tag time,
  nothing corrected it. Now pinned to `package.json` by a test, because
  "remember to bump the other file" is what produced the drift.

## [0.7.8] — 2026-08-23

**Upgrade from 0.7.7.** Two of 0.7.7's five fixes were wrong, and one of them
re-opened a bug 0.7.6 had fixed.

### Added

- Publishing now requires an acceptance record for the exact version being
  released (`acceptance/<version>.md`), checked by the publish workflow.

  Every regression this project has shipped was found by an independent
  acceptance pass — 0.7.0's wrong apply base, 0.7.2's dropped deletions,
  0.7.3's path base, 0.7.6's two miscalibrated guards, 0.7.7's under-counted
  escaping. Not one was missed. Every one was already on npm when the pass ran,
  because publishing came first. The review was never the problem; the ordering
  was, and it is mechanical now instead of remembered. A CONDITIONAL verdict
  passes deliberately — see `acceptance/README.md` for why.

### Fixed

- The command-line length check counts what cmd.exe actually costs.
  cross-spawn prefixes `^` to every meta character for a cmd.exe target and its
  class INCLUDES THE SPACE, which the previous hand-written model did not. Prose
  therefore failed from about 6,600 characters and JSON from about 4,500, while
  the guard did not fire until about 7,820 — so the raw
  "The command line is too long." went on reaching callers, and because the
  guard stayed silent the route was charged a call, a failure and a breaker
  event for it. The class is now taken from cross-spawn rather than guessed at.
- The same check applies the cmd.exe budget to any target that is not `.exe` or
  `.com`, which is what cross-spawn actually keys on. An extensionless shim or a
  `.ps1` was given the four-times-larger CreateProcess budget.
- A model naming the FORCED route itself is dropped again. 0.7.6 dropped it,
  0.7.7 forwarded it, and Codex rejected `--model codex_cli` with a real failed
  job and a breaker event. Over-specifying ("use codex_cli, with codex_cli") is
  the one ambiguous case; a model that merely collides with some OTHER route's
  id is still honoured, which is why one rule cannot cover both.
- `modelHintMatched` reports declared models only. It counted a route-NAME
  match as a match, so the one signal the tool schema tells an agent to use for
  self-correction — "true means the picked route actually declares this model" —
  reported the opposite of the truth.
- The long-prompt check MEASURES the command line instead of estimating it.
  Two releases running the escaping was hand-modelled and wrong in opposite
  directions: 0.7.6 under-counted spaces, 0.7.7 then over-counted backslashes
  and REFUSED an ~800-character band of prompts that ran fine on the Cursor
  route the check exists for. It now replicates cross-spawn's own escaping and
  measures the result, wrapper included, so the budget (8,180 of a measured
  ceiling of 8,191) buys margin rather than paying for a wrong model. A test
  pins it against cross-spawn's real output.
- A `node_modules/.bin/*.cmd` target is counted at its DOUBLE-escaped length,
  which is what cross-spawn does to npm shims. Such a target failed from about
  5,300 characters while the check said 6,400.
- `routing.modelHintDropped` tells you when a model you asked for was not sent
  on. Until now the only signal was `modelHintMatched: false`, documented as
  "forwarded blind — treat the result with more suspicion", which is the
  opposite of what happened: it was not forwarded at all.
- The top-level `service` parameter drops a self-naming model too. It took a
  third code path that never had the rule, so `service: "codex", hints.model:
  "codex"` still sent `--model codex` to the harness — the failure the forced
  path was fixed for — and reported neither field. All three paths now share
  one function.
- A blank `hints.model` is rejected on BOTH surfaces instead of silently
  unsetting the route's configured model. An empty string is not "no
  preference": it won against the route default, the harness ran with no model
  flag, and the response reported `model: ""` with nothing to say the request
  had been discarded. Whitespace did the same and also reached the harness as a
  real argument, so `--model "   "` cost a provider call, a route failure and
  breaker credit on an HTTP 200. The OpenAI protocol's own top-level `model`
  drops a blank value rather than rejecting it — clients fill that field in
  unconditionally — but it dropped only `""`, not whitespace, and it now drops
  both.
- A wrong-typed hint is rejected on the HTTP surface instead of vanishing.
  `hints: { model: 123 }` returned 200 with the hint silently gone, and
  `hints: "workspace_edit"` discarded EVERY hint in one go — safety ones
  included — because a non-object failed the branch guard without a word. This
  is the other half of the unknown-KEY rule already there.
- A whitespace-only `prompt` is rejected on the MCP surface, which the HTTP
  surface has always done. It passed the non-empty check and spent a real route
  call producing nothing.
- The HTTP surface stops silently downgrading a request it does not understand.
  `mode: "fanou"` ran ONE dispatch and returned 200, so a CI caller asking for
  independent opinions got a single answer indistinguishable from a real one;
  `stream: "true"` returned a non-streaming response the same way; a non-string
  entry in `files` or `models` was dropped, so a delegate ran without context
  the caller believed it had sent. All are refused by name now.
- `hints.timeoutMs` is checked for its VALUE, not just its type. `0` is not
  nullish, so it won every fallback down to `setTimeout`, fired on the first
  tick and killed the child — "Timed out after 0ms", recorded as a route
  failure with breaker credit, behind an HTTP 200. Negative, fractional and
  absurdly large values were accepted too; MCP has always refused all four.
- `routePolicy: "standard"` is accepted over HTTP. It is the router's own
  default and the documented one, so copying it out of the docs into an HTTP
  body was an error for naming the thing that already happens.
- A NUL byte is refused on both surfaces for every field that becomes a
  command-line argument — `prompt`, `files`, `models` and `hints.model` — not
  just `prompt`. The rest surfaced as a raw Node internal from deep inside
  process spawning.
- Top-level routing hints over HTTP take effect instead of being discarded.
  `{"routePolicy":"local_only"}` returned 200 and the dispatch left the machine
  anyway; `taskType`, `timeoutMs` and `preferLargeContext` were dropped the same
  way, while `safetyProfile` and `workspacePolicy` in the same position had
  always worked — which is what taught callers the placement was fine. OpenAI
  request bodies are flat, so this surface accepts flat hints; the MCP tool
  still refuses the placement by name, and on both a hint you set now either
  takes effect or you are told.
- `timeoutMs` is capped at what a timer can actually hold (2147483647). Above
  that Node clamps to 1 millisecond, so the longest timeout you could ask for
  became the shortest possible: the harness was killed immediately and the
  ROUTE was blamed. Both surfaces accepted values in that range.
- `contextJobs` and `service` are refused over HTTP rather than accepted and
  ignored. They are MCP tool parameters this surface does not implement — a
  caller passing `contextJobs` got a delegate running without the prior work
  they believed they had sent, and one passing `service` got whatever route the
  router picked.
- `escalate` is refused on both surfaces. It has never been a per-call field;
  escalation is per-route configuration.
- `routePolicy` is enforced in FANOUT mode over HTTP, not only in single mode.
  `{"mode":"fanout","hints":{"routePolicy":"blocked"}}` — documented as
  "dry-run: block everything" — returned 200 having run live agents in the
  caller's working tree, and `local_only` let a metered route run and bill.
  The fanout path built its dispatch options by naming three hint fields
  inline and missed two, so `timeoutMs` never reached the child there either.
  Every applicable hint now comes from one function, so a new one reaches
  every caller instead of whichever call sites someone remembered.
- The config.yaml spelling of a hint is refused at the TOP level on both
  surfaces — `safety_profile`, `route_policy`, `task_type` and the rest. The
  nested spelling has been refused since 0.6.x because it silently disabled a
  safety limit; one level up it stayed silent, and 0.7.8 made that placement
  more reachable by starting to honour top-level hints.
- A `null` hint value is refused rather than treated as absent, consistently.
  `{"timeoutMs":null}` returned 200 with the hint gone while
  `{"hints":{"timeoutMs":null}}` was a 400 — the same key, two answers.
- An environment failure is detected by SHAPE, not by how often the phrase
  appears. The detector overrides a successful exit — it charges the route a
  failure and tells the caller "any answer it gave was produced without reading
  or running anything" — so a delegate that merely WROTE about
  `CreateProcessAsUserW` was given a fabricated diagnosis of a run that worked.
  It now requires the harness's own diagnostic form (with errno) on two
  separate lines, and scans each stream's tail separately so a wall of stderr
  cannot bury a real failure on stdout.

## [0.7.7] — 2026-08-23

**Upgrade from 0.7.6.** Two of 0.7.6's three guards were miscalibrated — one
under-fired on the shipped Cursor route, one over-fired on an explicit request.

### Fixed

- The long-prompt check budgets a `.cmd`/`.bat` target at cmd.exe's 8,191
  characters instead of CreateProcess's 32,767. The shipped Cursor route is a
  `cursor-agent.CMD` PowerShell wrapper — not an npm shim — so cross-spawn
  re-spawns it through cmd.exe. A 9,031-character prompt therefore sailed past
  0.7.6's check and still failed with the bare "The command line is too long."
  that check exists to replace.
- The same check counts a prompt at its ESCAPED length. Windows escapes every
  `"` to `\"`, so a raw character count under-reads any JSON or source-code
  prompt: 31,000 characters at ~10% quotes measured under budget and threw
  `spawn ENAMETOOLONG` anyway.
- A model named on a FORCED route reaches the harness again. 0.7.6 stopped
  forwarding a route id as a model override, which was right on the scoring
  path and wrong on the forced one — there the caller has already chosen the
  route, so the value can only be a model, and a model whose name collided with
  some other route's id was silently swapped for the route default.
- A refused prompt is not charged to the route. The refusal happens before any
  process is spawned and fails identically on every argv route, so one over-long
  prompt cascading through three routes recorded three calls and three failures
  — and three such dispatches opened healthy routes for 300 seconds. The route
  was never asked to do anything.
- A background dispatch is refused outright when the config file no longer
  loads, instead of being reported orphaned 90 seconds later. The detached
  runner bootstraps from the config FILE, so a file the server can no longer
  load means no runner can start; the job then sat untouched until the orphan
  threshold declared it dead. Observed: a caller told "ended without a result
  (status: orphaned)" about a job whose own status.json later read
  completed/success. The server keeps the last config that loaded cleanly, which
  is why it could accept the dispatch at all — that divergence is the bug, and
  it is now named at the point of refusal.

## [0.7.6] — 2026-08-23

The three items an acceptance pass left open as judgement calls rather than
defects. All three are the same shape: the product knew something the caller
could have acted on and did not say it.

### Fixed

- A ROUTE ID passed as `hints.model` is no longer forwarded to the harness as a
  model override. `hints.model` accepts either a route id or a model name — the
  schema says so, and naming a route id is the documented way to nudge routing
  toward it. But the value was then also handed to whichever route WON as
  `--model`, so hinting a route that lost the decision sent a nonsense model to
  a real provider. Measured: one dispatch naming a configured local route was
  tried against four subscription CLIs, each rejecting `--model <route id>`,
  spending five calls and tripping two circuit breakers. A route id still steers
  routing exactly as before; it is simply not passed on as a model. A value that
  is not a configured route id keeps the forward-blind behaviour that makes an
  undeclared-but-real model usable.
- A prompt too long for a route's command line is refused with an explanation
  instead of `spawn ENAMETOOLONG`. Windows caps a command line at 32,767
  characters and POSIX caps a single argument at 128 KiB; past that the spawn
  failed with a raw errno pointing at nothing actionable. Checked per route
  rather than at the schema, because it genuinely is per route — codex reads the
  prompt from stdin and has no such limit, so a boundary cap would refuse work
  that route can do. The message says which routes can take it.
- A config reload that fails now says so on stderr. Keeping the previous config
  when an edit is malformed is right; saying nothing about it was not. The
  server stayed up, kept routing on the old config, and nothing distinguished
  "your edit is live" from "your edit was rejected ten minutes ago" — the edit
  looks applied because everything still works. Reported once per distinct
  error, not once per poll.

## [0.7.5] — 2026-08-23

### Fixed

- `usage` reports token totals on a long-running server, not just in a freshly
  started process. The cross-process refresh re-read calls, successes, failures
  and rate limits from disk and left the two token counters behind, so a server
  that had itself dispatched the work answered `inputTokens: 0` while the state
  file held 45,345. Only a later process showed the truth — which is the exact
  failure the refresh was written to fix, fixed for four fields out of six. The
  cross-process test asserted nothing about tokens, which is why it shipped.

### Changed

- Two assertions in the isolated-dispatch matrix now check what their comments
  already claimed. One said the patch "names the file the agent touched" while
  only asserting the patch was non-empty — a patch of the WRONG file is
  non-empty. The other skipped every expectation whose expected state was
  absence, so the DELETED and RENAMED rows verified nothing after discard at
  all, and a discard that resurrected a deleted file would have passed. The
  rows asserting a file is gone are the only ones such a bug could show up in.

  Both were found by an independent reviewer reading the file, one day after it
  was added to stop exactly this class of miss. A test that asserts less than
  it claims is worse than no test: it buys confidence that is not there.

## [0.7.4] — 2026-08-23

**Upgrade from 0.7.3 if you dispatch `git_worktree` jobs from a subdirectory.**
0.7.3's new divergence check refused every apply for those.

### Fixed

- The apply-time divergence check added in 0.7.3 resolved a `git_worktree` job's
  changed-file paths against the dispatch's working directory rather than the
  repository root, so every apply for a subdirectory dispatch was refused with
  "deleted since dispatch". The same path-base mistake 0.7.0 fixed in the
  neighbouring check, made again a few lines away; both call one function now.

### Added

- A test matrix over every isolated dispatch shape: `copy` and `git_worktree`,
  at the repository root and in a subdirectory, for a file the agent MODIFIED,
  CREATED, DELETED and RENAMED. It drives the real prepare/finish path rather
  than hand-built fixtures, and asserts on the user's files on disk rather than
  on what the tool reports — every defect this area has produced reported
  success while doing the wrong thing.

  It earns its place by catching what shipped. Reintroducing 0.7.0's wrong-base
  bug fails 4 of its 16 cases; reintroducing 0.7.2's dropped-deletion bug fails
  a different 4; and it found the divergence-check bug above on its first run.
  Each of those was previously found by a reviewer rebuilding this matrix by
  hand, after release.

## [0.7.3] — 2026-08-23

**Upgrade from 0.7.2 if you use `workspace_policy: copy`.** 0.7.2 introduced a
regression that drops file deletions, and only half-fixed the concurrency
problem it was written for.

### Fixed

- A `copy` patch carries DELETIONS again. 0.7.2's per-file rewrite forced both
  sides of a deleted file to `/dev/null`, so the can't-be-diffed guard fired
  every time and no copy patch ever contained one: a delegate that removed a
  file had `applied: true` reported over a project where the file was still
  there. A delete-only job produced an empty patch that `apply` refused and
  `discard` then refused to clean up, leaving the job unescapable without
  `force`. Renames did not land either — a rename is a delete plus an add.
- `apply` refuses when the project has moved under the patch, instead of
  silently overwriting. This is the half of the 0.7.2 concurrency fix that was
  missing. Excluding untouched files stopped one job deleting another's work,
  but for a file BOTH jobs touched the patch is generated against the project as
  it stands at apply time — so its context always matches, git applies it
  cleanly, and the other version is simply replaced. Apply job A, commit it,
  apply job B, and A's committed line was gone with `applied: true` and no
  warning.

  Each changed file now records what it looked like when the dispatch started,
  and apply compares that against the project before touching anything. A
  worktree patch gets this from its base commit; a copy patch had no equivalent
  and now does. `force: true` overrides, and `retry_job` re-runs the task
  against the current tree.

  Line endings are normalised for that comparison, so a checkout whose eol
  settings rewrote a file on the way in is not mistaken for someone else's edit
  — that false positive would refuse every apply on Windows.

## [0.7.2] — 2026-08-23

**Upgrade if you run more than one isolated dispatch against the same project.**
An eighth independent acceptance pass found that applying a second `copy` job
could silently revert and delete the first one's committed work.

### Fixed

- A `copy` patch is built FILE BY FILE from the recorded changed-file list,
  instead of by comparing the whole workspace against the project.

  The tree comparison had no BASE: it diffed against the project as it stood at
  APPLY time, so everything that had changed in the project since the copy was
  taken was proposed for reversal. Dispatch two isolated jobs, apply the first,
  commit it, apply the second — and the second deleted the first's committed
  file and reverted its committed line, reporting `applied: true` with a
  changed-file list one entry shorter than the patch it had just applied. That
  is the parallel-delegation case this product exists for, and the refusal on
  uncommitted changes was no help: it says "commit or stash first", and
  committing is what walks you into it.

  `git_worktree` never had this, because it diffs against a recorded base
  commit — and its own error text spells the hazard out. The danger was
  documented for one policy and unguarded in the other. Patch and changed-file
  list now come from the same source, so they cannot disagree either.
- The HTTP surface rejects an invalid enum VALUE instead of dropping it.
  `hints.safetyProfile: "read_onlyy"` returned 200 and ran the dispatch
  write-capable, while the correctly spelled value produced a read-only run and
  the MCP surface rejects the same input by name. The unknown-KEY check added
  earlier was written for exactly this failure and covered half of it.
  `taskType`, `safetyProfile`, `workspacePolicy` and `routePolicy` are all
  checked now, at both the top level and inside `hints`.
- A cancelled job reports `completed: true`. `completed` is the field the tool
  descriptions tell an agent to branch on, and `cancelled` was missing from the
  terminal set — so an orchestrator that cancelled a job and then polled it was
  told to keep checking, with a 300-second poll interval, forever.
- The path-length hint fires for git's `Could not access` wording, not only
  `Could not open directory`. The first version pinned the one string that had
  been observed — a directory scan — and missed the file-stat variant, which is
  what an over-long path usually produces, so the case the hint exists to
  explain got a bare error.

## [0.7.1] — 2026-08-23

**Upgrade from 0.7.0 immediately if you dispatch with `workspace_policy: copy`
from a subdirectory of a repository.** 0.7.0 introduced a regression that writes
to the wrong files.

### Fixed

- A `copy` patch is applied relative to the dispatch's working directory again.
  0.7.0 started applying from the repository root, which is right for a
  `git_worktree` patch (repo-relative) and wrong for a `copy` patch
  (workingDir-relative) — the same change was applied to both policies without
  distinguishing them. In a monorepo the effect ranged from conflict markers
  written into a root file the delegate had never seen, to silently editing and
  DELETING same-named files at the root while reporting "Applied N bytes" and
  leaving the intended subdirectory untouched. `--directory` is git's own answer
  and is what is used now. Verified against real git three ways, because
  applying from the subdirectory instead is the silent no-op this area started
  with.
- A workspaces root inside the project no longer copies itself, forever.
  `HARNESS_DISPATCH_WORKSPACES_DIR` pointing inside the project — which the
  README and the 0.7.0 notes recommend, to keep the copy on the project's volume
  where a reflink is possible — made the copy walk into the workspace it was
  writing: 201 levels of nesting and an 11,800-character path on a six-file
  project before the run was killed. The whole workspaces area is excluded from
  a copy now, compared as resolved absolute paths.
- Pruning a stale `git_worktree` workspace removes it through git even when a
  `copy` dispatch is what triggered the prune. Sharing one root between the two
  policies (new in 0.7.0) meant an `rm -rf` could leave the directory gone while
  git still listed the worktree as prunable, with `.git/worktrees/<name>` behind
  it — which the retention code's own comment warns can eventually break
  `git worktree add`.
- Each project gets its own directory under `HARNESS_DISPATCH_WORKSPACES_DIR`.
  The override previously used one flat directory for everything, so a dispatch
  in one project pruned another's aged workspaces. The per-project segment is
  keyed on the full path, not the basename, because two checkouts both called
  `api` are an ordinary thing to have.

## [0.7.0] — 2026-08-23

**Isolated workspaces have moved out of your project.** A sixth independent
acceptance pass blocked the release on data loss, and this time the answer was
not another filter.

### Changed

- A `copy` workspace is created under the system temp directory, not at
  `<project>/.harness-dispatch/workspaces/`. `git_worktree` already worked this
  way — which is exactly why none of the defects below ever affected it — and
  both now use one root. Set `HARNESS_DISPATCH_WORKSPACES_DIR` to override it,
  for instance to keep workspaces on the project's own volume where a
  copy-on-write clone is possible; a temp directory on another volume falls back
  to an ordinary copy.

  Nesting the copy inside the directory it was isolating from caused a defect in
  every acceptance pass of the 0.6 series, because `git diff --no-index
  <project> <copy>` then walks into the copy while scanning the project. Each was
  fixed with a filter and each filter turned out to have a gap. This removes the
  cause.

### Fixed

- **Applying one job's patch no longer destroys another job's workspace.**
  Sibling workspaces, retained 24h by design, leaked into the patch as deletions:
  applying job 1 emptied job 2's workspace — the second delegate's only copy of
  its work — and said nothing, and job 2's patch then proposed deleting the
  user's own files. This fired on the **second** isolated dispatch into any
  project, which is the parallel-delegation case the product is built around.
- **The patch no longer rewrites file CONTENT that contains the project path.**
  The project root was stripped from every line of the patch, content included:
  a delegate wrote `const dataDir = "<project>/data"` and the project received
  `const dataDir = "data"`, reported as a clean apply. Header lines are decided
  by position now, so a content line can never be mistaken for one.
- **`apply` works when the dispatch ran in a subdirectory of the repo.** `git
  apply` resolves paths at the repository root regardless of where it is invoked,
  so from a subdirectory it found nothing, printed `Skipped patch`, exited 0 —
  and the tool reported "Applied N bytes" for a run that changed nothing. It
  applies from the repo root now, and a `Skipped patch` is treated as the failure
  it is.
- **`apply` no longer refuses on a clean project in a monorepo.** The filter that
  keeps the tool's own directory out of the dirty check matched only a
  first-segment `.harness-dispatch/`, while git reports `sub/.harness-dispatch/`
  from a subdirectory — the feature blocking itself with its own leftovers, for
  every `apps/*` layout.
- **`discard` no longer refuses after a successful apply.** A worktree's
  changed-file paths are relative to the repo root and were joined onto the
  dispatch's working directory, so a subdirectory dispatch looked for
  `<repo>/sub/sub/a.txt` and concluded the work was missing — an unresolvable
  loop without `force`.
- **`discard` no longer claims "the original project was never modified"** when
  an apply modified it moments earlier. Discard speaks for itself only.

## [0.6.6] — 2026-08-22

Four findings from a fifth independent acceptance pass — the first to drive
real harness CLIs rather than fakes. All four are the same shape: the tool told
you something that was not what happened.

### Fixed

- A `git diff` FAILURE is no longer returned as an empty patch. git exits 1 both
  for "there are differences" and for real errors, and the two were
  indistinguishable here, so a copy workspace whose paths crossed Windows
  MAX_PATH produced `error: Could not open directory <259 chars>` on stderr, an
  empty stdout — and a patch of zero bytes, which every caller reads as "the
  agent changed nothing". git's own explanation was discarded and never reached
  anyone; the user was told to file a bug report instead of the actual cause.
  `error:`/`fatal:` on stderr now surfaces as an error, with a path-length hint
  where that is what it looks like. Routine `warning:` lines (line-ending
  conversion) still do not count as failure.
- `apply` can no longer report failure while leaving your project rewritten.
  `git apply --3way` is not atomic: on conflict it writes `<<<<<<< ours` markers
  INTO the target and then exits non-zero, and it was tried FIRST — so a failed
  apply reported "resolve by hand" over a file it had already changed. Plain
  apply, which applies everything or nothing, goes first now; `--3way` remains
  for the case it exists for. If an attempt does modify the project anyway, the
  message says so and names the files.
- `discard` refuses to destroy changes your project does not have. `apply` could
  end with "Do NOT discard this job — the workspace still holds the files", and
  the very next `discard` deleted them and answered "The original project was
  never modified." Pass `force: true` to throw them away deliberately.
- `apply` with `force: true` names the uncommitted changes it ran over instead
  of answering exactly like a clean apply. Forcing waives the refusal; it does
  not license silence about what was replaced.

## [0.6.5] — 2026-08-22

Three findings from a fourth independent acceptance pass. The first is the one
with real consequences; the second is a regression 0.6.3 introduced.

### Fixed

- A pooled supervisor picks up config edits before claiming work. A supervisor
  outlives the server that spawned it by design, and it was also outliving that
  server's CONFIG: remove a route, restart, and dispatch within about five
  seconds, and the old supervisor claimed the job and ran the removed route,
  reporting plain success with nothing signalling the split. For that window
  `disabled:`, `allow_paid_usage` and safety profiles were not the controls they
  appear to be. Reloading is mtime-gated, so the steady-state cost is one stat
  per poll, and a malformed edit keeps the previous config rather than killing
  the supervisor.
- Applying twice no longer reports data loss. 0.6.3 added a guard for "changed
  files recorded but the patch is empty", which is the shape of a patch that
  lost something — and also the shape of a second `apply`, where the project
  legitimately matches the workspace already. It now checks whether those files
  actually reached the project and answers "already applied" when they did.
  Line endings are normalised for that comparison: `git apply` writes through
  the repository's eol settings, so an applied file routinely lands as CRLF
  against an LF workspace copy, and comparing raw bytes would have raised the
  false alarm on the platform it was reported from.
- The `EACCES` message from `serve` no longer blames privileges for a high
  port. Windows reserves whole port ranges, where elevation changes nothing;
  0.6.4 told anyone hitting one to fix something unrelated.

## [0.6.4] — 2026-08-22

The two non-blocking findings left over from 0.6.3's acceptance pass.

### Fixed

- A run in which the harness could not spawn ANY child process is reported as a
  failure, not a success. Codex's Windows sandbox refused every spawn on a deep
  path (`CreateProcessAsUserW failed: 5`), the delegate replied "Unable to read
  file." having read nothing, the process exited 0, and a lenient route returned
  `success: true` — counting a success in `usage`, leaving the breaker closed,
  after 57k tokens and 63 seconds. The router then kept choosing a route that
  could not do anything, which is the shape PRODUCT.md names as a counter-signal.
  The error now says what happened and what to try. Deliberately narrow: it
  matches the harness failing to START a process, not a tool call that failed —
  an agent hitting a permission error and working around it is normal work.
- `serve` on a busy port prints one actionable line instead of a stack trace. A
  listen failure arrives as an 'error' event rather than a rejected call, so with
  no handler Node rethrew it from the event loop: `node:events:486 throw er; //
  Unhandled 'error' event`. `EACCES` and `EADDRNOTAVAIL` are named too.

## [0.6.3] — 2026-08-22

**Upgrade if you use `workspace_policy: copy`.** A third independent acceptance
pass blocked the release on work being silently lost, in the feature whose whole
job is not losing it. Present in 0.6.0, 0.6.1 and 0.6.2.

### Fixed

- A `copy` dispatch returns a file the agent CREATED. It did not: the patch came
  back empty, `apply` said "the agent changed nothing" beside its own list
  saying the file was added, and `discard` then deleted the only copy. A copy
  workspace lives inside the project, so a created file appears on both sides of
  the comparison with identical content — once under
  `.harness-dispatch/.../workspace/` while git scans the project, once at its
  real path inside the copy. Rename detection paired the two and emitted nothing
  at all for that file. A MODIFIED file was unaffected, which is why this
  survived three releases and every live test: they all edited an existing file.
- `apply` refuses instead of reporting "nothing to apply" when the recorded
  changed-file list is not empty but the patch is. That combination means the
  patch lost something, and the reassuring message is the one a user acts on
  before discarding the workspace. It now names the files, says not to discard,
  and gives the path they are still sitting at.
- `discard` retries removing the workspace. The agent CLI has only just exited
  and Windows can still hold a handle on something it wrote — observed live as
  `EBUSY: rmdir ...\workspace` on a discard issued straight after a successful
  apply, where the same removal succeeded moments later. A failure here strands
  the workspace inside the user's project, which is the one place it must not be
  left.

## [0.6.2] — 2026-08-21

Three defects from a second independent acceptance pass, two of which
contradicted claims made in this changelog.

### Fixed

- `HARNESS_DISPATCH_CONFIG` is honoured by the CLI and the MCP server, not only
  by the detached job runner. With the variable set in the ambient environment,
  the server routed on auto-detected defaults while the runner it spawned loaded
  the file the variable named — the two halves of one dispatch working from
  different configs, with nothing reporting the split. Pointing it at a file that
  does not exist is now an error, which 0.6.0 claimed and only the runner
  delivered. Both processes resolve the path through the same function, so they
  cannot drift apart again.
- `usage` shows token totals in its human output. They were reaching
  `usage --json` and the MCP tool but not the text a person actually types at, so
  the surface the 0.6.0 and 0.6.1 notes described was the one place they never
  appeared. A route whose harness reported nothing prints no token line at all,
  rather than a zero that would read as "nothing was spent".
- The "nothing was eligible" error names what actually happened instead of
  asserting all three of disabled, exhausted and circuit-broken. A route the
  operator deliberately blocked on billing was reported as a route health
  problem, printed beside a breaker blob reading `tripped:false, failures:0`.
  Breakers are now named only when one is genuinely tripped. The machine-readable
  `skippedRoutes` detail is unchanged — it was accurate all along.

## [0.6.1] — 2026-08-21

Two defects found by an independent acceptance pass against 0.6.0, both
contradicting something the release claimed.

### Fixed

- `usage` token totals were meaningless for Claude Code. Anthropic splits a
  turn's input across three sibling fields, and only the first — the uncached
  remainder — was read: a turn that consumed 55,213 input tokens was recorded as
  2, and a route showed 28 input tokens across 58 real calls. Cached input is
  now counted, via a new `input_extra`/`output_extra` list on a protocol's
  `usage` mapping whose entries are SUMMED, as against `input`/`output`, which
  are alternative spellings of one quantity and stay first-match-wins. 0.6.0
  advertised token totals; the number it printed was four orders of magnitude
  low.
- `configure` no longer drops an `api_key: ${VAR}` reference when the variable
  is not set in the current shell. The reference resolved to an empty string,
  which is indistinguishable from "this route has no key", so the route was
  re-emitted with no `api_key` line at all — and `configure --yes --force`
  wrote that over a working config, silently deleting the key. References are
  now recorded per route before interpolation, which is the only point at which
  an unset variable is still distinguishable from any other unset variable.

## [0.6.0] — 2026-08-21

The job lifecycle is complete: start, watch, **stop**, **retry**, and **resolve the
isolated result**. Every verb was exercised against real harness CLIs rather than
fakes. The MCP surface grows from three tools to six.

### Added

- **`retry_job`** — run a finished job's task again from its own record: the same
  prompt the delegate actually saw (context preamble included), files, working
  directory, hints and workspace policy. Pass `service` to send the retry to a
  DIFFERENT route, which is the usual reason to retry — the task was fine and the
  route was not. Returns a new jobId; the original is untouched, and retrying a
  still-running job is refused so two attempts cannot race on one directory.
- **Token totals in `usage`** — `inputTokens` and `outputTokens` per route, summed
  from what harnesses actually report. Deliberately not money: subscription CLIs have
  no per-call price, and pricing tokens would mean shipping a rate card that goes
  stale silently. Zero means the harness reported nothing, not that nothing was spent.
- **`workspace`** — inspect, keep or discard the isolated result of a job. `copy` and
  `git_worktree` dispatches already ran the agent in isolation and never touched your
  project, but there was no way to see the actual change, no way to keep it, and no
  cleanup but by hand — so isolated runs were effectively write-only. `action: "diff"`
  returns the real patch, `"apply"` applies it to your project (refusing when the
  project has uncommitted changes, because the patch was built against a clean base),
  and `"discard"` removes the workspace. The patch is always written to the job
  directory, so applying it by hand is available even when the automatic path declines.
- **`resource_weight`** on a route — the concurrency bound now counts CAPACITY, not
  jobs. `max_concurrent_runs` priced an HTTP call to a local endpoint the same as a
  whole Claude Code process, so four cheap endpoint calls could lock out a real
  dispatch. Defaults to 1.0 for CLI routes and 0.1 for endpoints; with every weight at
  1.0 the arithmetic is exactly the old count, so existing configs are unchanged.
- **`cancel_job`** — stop a dispatch you already started. Until now the product could
  start a 60-minute detached run and offer no way to stop it, so a misdirected agent
  kept spending subscription quota and editing a workspace until it finished or timed
  out. A queued job stops outright; a running one tears down within about a second,
  killing the agent CLI and its child processes. Two things it does not do: it does
  not revert files the agent already changed, and it does not count as a route
  failure — the caller changing their mind says nothing about whether the route works.

### Changed

- All three route shapes (`clis:`, `endpoints:`, `services:`) resolve their shared
  settings through one table instead of three hand-written lists. This retires the
  class of bug that produced five separate silent drops, where a correctly spelled,
  correctly valued setting was read by one route shape and ignored by another. A
  legacy `services:` entry naming a harness now also inherits that harness's
  `leaderboard_model` and `thinking_level`, which it previously lost.
- `HARNESS_DISPATCH_CONFIG` pointing at a file that does not exist is now reported by
  the server instead of being silently replaced with auto-detected defaults.
- `install-codex.mjs --config` resolves to an absolute path and is checked at install
  time. A relative path used to be stored as written and resolved later against a
  different working directory, which silently meant "no config".

### Removed

- The unused dashboard renderer (`renderDashboard`, `DashboardState`). Nothing in the
  product called it; the `dashboard` CLI alias maps to `status` and is unaffected.

### Fixed

- Copying a live working directory survives a file disappearing mid-copy. A working
  directory is being written to while it is read — an editor saving, a build watcher
  cleaning, another fanout arm — and any of those used to fail the whole dispatch with
  a raw ENOENT. A vanished file is now skipped and named in the workspace notes; a
  permission error or a full disk still fails loudly.
- Workspace copies ask the filesystem for a copy-on-write reflink
  (`COPYFILE_FICLONE`), which makes a clone near-instant and allocation-free on APFS,
  Btrfs/XFS and ReFS/Dev Drive, and falls back to an ordinary copy everywhere else.
- `workspace` on a `copy` job no longer emits a spurious deletion of the file it is
  editing, and no longer refuses to apply because of its own scratch directory. The
  workspace lives inside the project, which broke both.
- Live agent smoke tests no longer write circuit-breaker state into the real install,
  so a smoke failure cannot block a healthy route for real dispatches.

## [0.5.0] — 2026-08-20

Published to npm on 2026-08-21, with a signed provenance attestation from GitHub
Actions. Anyone on 0.4.0 should upgrade: that release writes resolved API keys into
`configure` output and can destroy a hand-written config.

### Security

- `configure` no longer writes resolved API keys into its output. Keys that came from
  a `${VAR}` reference round-trip as that reference; a literal key is redacted in
  `--print` (which people paste into bug reports) and preserved on disk.
- A dispatch asking for a lower safety profile can no longer be silently ignored. The
  keys that grant or restrict access are rejected by name when misplaced, on the MCP
  surface that actually ships — a previous guard existed only on a code path nothing
  called.
- Symlinks can no longer carry an agent out of an isolated (`copy`) workspace.
- Endpoint hostnames are redacted from status output.

### Added

- Chain delegated work: pass `contextJobs` and an earlier job's prompt and output are
  rendered into the new prompt directly, without routing them through the orchestrator's
  own context.
- `max_concurrent_runs` (default 4) bounds how many agent CLIs run at once,
  machine-wide. Extra dispatches queue and start as slots free; nothing is rejected.
- A route's capability floor can vary by requested safety profile, which lets Cursor
  serve read-only work on Windows instead of being skipped entirely.
- `usage` reports per-route call counts, quota, billing kind and breaker state,
  including work done by detached job runners in other processes.

### Changed

- Arena ELO scoring is opt-in (`leaderboard: { enabled: true }`). Routing defaults to
  the tier and weight you configured rather than a benchmark maintained elsewhere.
- Rate-limited calls are counted separately from failures, so a busy route does not
  accumulate a permanent record of being unreliable.
- `retention: { jobs_days: 0 }` means keep forever, and a running job with a live
  heartbeat is never pruned.

### Fixed

- Nothing is lost to a timeout. Every dispatch runs as a detached background job that
  survives a client timeout, a server restart, and the MCP call's own deadline.
- `workspace_policy: shared_locked` serializes across all processes, not just within
  one. Stale-lock takeover is atomic, so two dispatches can no longer both decide a
  lock is free and edit the same directory.
- Circuit-breaker cooldowns and failure decay survive process boundaries and upgrades;
  `status` and `dispatch` no longer disagree about whether a route is available.
- The OpenAI-compatible HTTP endpoint is backed by a persisted job, so a client that
  times out mid-run can still retrieve the result.
- A rate limit is detected from HTTP status context rather than any occurrence of the
  digits 429 in an agent's output, which used to block healthy routes.
- Bad input gets one actionable line instead of a stack trace or a silent default —
  a missing `--config`, a malformed YAML file, an unknown route id, a typo'd setting.
- `configure --yes --force` no longer deletes harnesses the user added.
- On macOS and Linux, timing out an agent CLI also stops the shells and test runners
  it spawned.

## [0.4.0] — 2026-07-25

First release under the `harness-dispatch` name (previously `harness-router`). Bumped
the MCP surface to three tools: `dispatch`, `job_status`, `usage`.

Known issues in this release, fixed in 0.5.0: `configure` writes resolved API keys into
its output, and `configure --yes --force` can delete user-added harnesses.

[Unreleased]: https://github.com/fstubner/harness-dispatch/compare/v0.7.9...HEAD
[0.7.9]: https://github.com/fstubner/harness-dispatch/compare/v0.7.8...v0.7.9
[0.7.8]: https://github.com/fstubner/harness-dispatch/compare/v0.7.7...v0.7.8
[0.7.7]: https://github.com/fstubner/harness-dispatch/compare/v0.7.6...v0.7.7
[0.7.6]: https://github.com/fstubner/harness-dispatch/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/fstubner/harness-dispatch/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/fstubner/harness-dispatch/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/fstubner/harness-dispatch/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/fstubner/harness-dispatch/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/fstubner/harness-dispatch/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/fstubner/harness-dispatch/compare/v0.6.6...v0.7.0
[0.6.6]: https://github.com/fstubner/harness-dispatch/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/fstubner/harness-dispatch/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/fstubner/harness-dispatch/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/fstubner/harness-dispatch/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/fstubner/harness-dispatch/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/fstubner/harness-dispatch/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/fstubner/harness-dispatch/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/fstubner/harness-dispatch/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fstubner/harness-dispatch/releases/tag/v0.4.0
