# Changelog

Notable changes per release. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html) and is
pre-1.0, so minor versions can carry behaviour changes.

## [Unreleased]

### Fixed

- **The shipped harness defaults are read through the same field table as
  everything else**, closing a silent drop that was already live. Route
  settings resolve through one shared table so that a key works on `clis:`,
  `endpoints:` and the legacy `services:` at once — but the parser for the
  shipped defaults still hand-wrote its own list, and had drifted:
  `thinking_level` on a built-in harness entry was parsed by nobody, while
  the table reads that very field as the fallback for every user route of
  that harness. Exactly the silent-drop shape the table exists to retire,
  one layer underneath it. A row added to the table now reaches the defaults
  layer too, instead of needing to be remembered in a fourth place.

- **The two workspace policies no longer keep separate copies of the guards
  that protect a recursive delete**, and those guards are now tested on
  Windows, where the attack they exist for was originally measured. `copy`
  and `git_worktree` each had their own prune function and their own
  create-and-verify sequence, ~55 and ~30 lines, identical but for a git
  root. That duplication is why the symlink class took four releases to
  close: each fix landed in one copy, shipped as done, and the next review
  found the other still exploitable. The comment left behind said "whenever
  one of these gets a guard, check the other in the same edit" — a process
  rule standing in for a shared function, which now exists.

  The tests that cover those guards were skipped on Windows because an
  unprivileged `symlink(..., "dir")` fails there. A junction does not, and
  `lstat` reports one as a symbolic link, so the code under test sees what
  it sees on POSIX. Two of the six skips are gone.

  Three deliberate breakages that the suite previously did NOT catch — the
  sweep's name check removed, the verify-before-prune ordering reversed, and
  the symlink refusal removed — now each fail their own test. The gap was
  that the destructive path only runs past the 24-hour retention window and
  no test aged anything, so the delete never happened and the guards were
  never asked. Two new tests age a directory on purpose.

- **A patch-building path no input could reach has been removed, along with
  the ~800-line test suite guarding it.** When a `copy` job had no recorded
  changed-file list, the patch was built by diffing the whole original
  directory against the whole workspace — a comparison that reports every
  excluded directory as deleted, so ~170 lines of path normalisation and
  section filtering existed to make its output safe to apply. The field it
  falls back from has been recorded since 2026-07-13 and an isolated
  workspace is pruned after a day, so no run reaching this code could still
  exist; its own comment still described the copy as living inside the
  project, which stopped being true in 0.7.0. Such a job is now refused with
  the path to its workspace, matching what the `git_worktree` branch beside
  it already did. Two tests that had been passing only because their fixture
  omitted the field now run against the current path, and one of them turns
  out to pin something real: discard refuses to destroy unapplied work, a
  guard the old fixture never triggered.

- **Dead imports and locals can no longer accumulate unnoticed.** The
  compiler was not asked about them, and 38 had built up across twelve
  files: three whole import declarations nothing read, a function nobody
  called, a parameter threaded through a signature after the code that used
  it was fixed, and two catch blocks computing a message they discarded.
  Individually harmless; in bulk they are what makes a reader unable to tell
  what is load-bearing. All 38 removed, and `noUnusedLocals` /
  `noUnusedParameters` are now on, so the next one fails the build rather
  than joining the pile.

- **The router had two implementations of every dispatch path, and its own
  header said otherwise.** `route()`/`routeTo()` and `stream()`/`streamTo()`
  were separate selection-and-fallback loops, with a second copy of the
  workspace-policy wrapper beside them — about 250 lines that had to stay in
  step and did not. The file's header claimed the buffered methods were
  "reimplemented on top of the streaming primitives", which is what made the
  drift invisible: the timeout rule ended up written four times, and only the
  `route()` copy was covered by a test, while background jobs and every HTTP
  request run on the streaming pair. The buffered methods now drain the same
  loop. One thing is still chosen per entry point, and only one: whether the
  dispatcher is asked through `dispatch()` or `stream()` — an endpoint route
  keeps its non-streaming request, which sets `stream: false` on the wire, so
  no live traffic changes shape. Behaviour is otherwise unchanged; 123 lines
  are gone.

- **An empty `HARNESS_DISPATCH_STATE_DIR` sent every state path to the
  current directory.** The lookup used `??`, which treats an empty string as
  a real value — and an empty value is what a launcher or shell produces
  when it forwards a variable that is not set. The state root became `""`,
  so config, jobs, breaker state, quota counters and logs all resolved
  against wherever the process happened to start: the cwd-dependent bug this
  module's own comment says was fixed. A relative value is now anchored too,
  so a job runner spawned with a different working directory cannot read a
  different state root than the server that spawned it.

- **`doctor` no longer reports a Codex that is installed but not logged in
  as logged in** when its CLI prints usage text and exits 0, which is what a
  build without the `login status` subcommand does. Exit code and output
  must now agree. Also, the login probe's synchronous spawn-failure path
  bypassed its own settled guard.

- `doctor`'s `config` line now distinguishes a file that defines no routes
  from one that defines routes AND asks for detection with `detect: true`.
  It reported the former for both, which reads as though the file were being
  ignored.

- **The plugin's `/setup` command no longer walks users into a config that
  removes every CLI harness.** It told them to write `disabled:`,
  `overrides:` and `endpoints:` together — and a config carrying
  `endpoints:` is authoritative, so detection switches off, the two tuning
  keys apply to nothing, and Claude Code, Codex, Cursor and Antigravity all
  vanish from the route table. That is not hypothetical: the maintainer's
  own config had this shape, and no dispatch on that machine could reach a
  CLI harness for four days after 0.9.0 shipped the authoritative rule. The
  command now states the rule up front, points at `configure --yes` first,
  offers two valid shapes (`detect: true` plus `endpoints:`, or a fully
  explicit `clis:`), and ends by reading the two `doctor` lines that report
  the mistake. Also corrected in the plugin: the "not yet published" note
  (0.9.0 is on npm), the config-resolution order (it omitted `./config.yaml`
  and the state-dir variable), the claim that `hints.model` is unvalidated,
  and the command list, which omitted `/setup`.
- **Two rules that a user depends on were passing while broken.** An audit
  broke fifteen guards on purpose to see which the suite would catch; these
  are the two that got through. First, "a per-call `timeoutMs` beats the
  service's configured default" is written out four times in `router.ts`,
  once per entry point, and only the `route()` copy was tested — while
  background jobs and every HTTP request go through `stream()`/`streamTo()`,
  so the copies that carry real traffic were unpinned. Second, the HTTP
  bearer check was only ever tested with the header MISSING: a server that
  accepted any `Bearer` value at all passed every test in its own file, and
  token rotation on a running server was never exercised. Both now have
  table-driven tests covering every entry point and every authenticated
  route, including a wrong token of the same length, an empty one, and one
  without the scheme. No behaviour changed; the tests are what changed.

- README corrected in nine places found by an audit against the code: the
  Configure section described a verification step and an interactive
  choice of harnesses, model priority and safety profile that do not exist;
  Claude Code billing was still described as date-aware when the code
  classifies it as plan usage unconditionally; the CLI list omitted the
  public `dispatch` command while calling `route` the hidden one (it is the
  alias); the endpoint-mode example used the legacy `services:` format
  without saying so, which silently drops `clis:` routes when pasted into a
  modern config; two different default timeouts were stated (60 minutes is
  right for every MCP and HTTP dispatch); `job_status` with no id was said
  to return every job (it returns the twenty newest); `configure`'s target
  omitted that a `./config.yaml` still wins; `usage listModels` was said to
  fetch live when a declared list is returned as-is; and a duplicated
  endpoint line.

- **`configure` no longer regenerates away a comment you put above its
  header, and no longer counts a stripped final newline as an edit.** The
  unedited check accepted any comment lines above the fingerprint, so a
  `# note to self` at the top of the file was overwritten without a word;
  meanwhile an editor that drops the trailing newline made the file count
  as edited and forced `--force`. Only the exact header may sit above the
  fingerprint now, and trailing whitespace is ignored when fingerprinting.
  (Twenty-fifth acceptance pass, finding 4.)

- **`doctor` names a harness on PATH that an authoritative config leaves
  out.** A config listing its own routes is authoritative, so a harness
  installed afterwards is simply absent — and `routes` said "1 ready
  route(s)" with a second CLI installed and no hint; the PATH hint only
  appeared at zero routes. It now adds "Installed but not in this config:
  claude — add `detect: true` to <file> to merge them, or a clis: entry".
  (Finding 5.)

- **`--config` at the boundary.** A directory produced a raw `EISDIR` that
  named no path; it now says which path is a directory. `--config=` (empty)
  silently auto-detected and reported the routes as loaded "from" the
  current directory; it is now the same usage error as a missing value. An
  empty or routes-free config file was reported as the source of routes
  that detection had found; doctor's `config` line now says they were
  auto-detected and that the file defines no routes of its own. (Finding 3.
  A load failure under `doctor --json` still prints text, not JSON.)

## [0.9.0] — 2026-09-02

### Changed (breaking)

- **A config file that defines routes is now authoritative about them.**
  Auto-detection used to run unconditionally, so a file with `clis:` or
  `endpoints:` entries ADDED to the installed harnesses rather than replacing
  them, and only `disabled:` — naming every route, including ones you might
  not know existed — subtracted.

  That default caught three acceptance passes in a row despite explicit
  warnings, and caught this project's own test suite: one test dispatched to
  the real Claude Code CLI on every `npm test` and every CI run, under a
  comment asserting it could not reach a route. It also decayed — adding
  support for a new harness would auto-add it to every existing config, so a
  `disabled:` list written today quietly stopped isolating tomorrow.

  The legacy `services:` format has always behaved this way, so the two shapes
  now agree rather than this being a new rule.

  **What changes for you.** A config that has a `clis:` or `endpoints:` key
  gets exactly the routes listed under it — including `clis: []`, which means
  no CLI routes. Add `detect: true` to keep the old behaviour. A config
  mentioning NEITHER key — one carrying only `overrides:`, `disabled:` or
  settings — still auto-detects, because a file cannot be authoritative about
  routes it does not describe; it now says so in a warning. `detect: false`
  turns detection off outright.

  Note that `disabled:` and `overrides:` tune AUTO-DETECTION, so they do
  nothing in a config that lists its own routes — remove the entry instead.
  The config the README tells you to copy said the opposite of this until it
  was corrected in the same release; check yours if you wrote it from that.

### Fixed

- **Re-running `configure` after installing a harness no longer needs
  `--force`.** The natural first-run order — install this tool, configure,
  find out a harness is needed, install one, configure again — was refused
  at the last step: "already exists ... --force". And had the first run found
  anything, the re-run would have loaded that file as authoritative and not
  detected the new harness at all. `configure` now stamps what it writes
  with a fingerprint; a re-run that finds its own unedited output regenerates
  it from a fresh detection, and says so. A file that has been edited, or
  that configure did not write, is still loaded (so its settings migrate)
  and still refused without `--force` — and since such a file lists its own
  routes, `--force` regenerates it from the file, not from a detection. It
  used to print "Detected N harness routes" there anyway; an acceptance pass
  measured that line with a second harness on PATH that never appeared. It
  now says detection did not run and how to merge (`detect: true`). The
  non-interactive hint at the end of `configure --yes` also told the user to
  pass `--yes`, which they just had; it now names `connect`. Seen on the
  cold-install walk.

- **`connect` now registers with a Claude Code that has never been opened.**
  A client counted as installed only if its config file existed, and Claude
  Code writes `~/.claude.json` on its first interactive launch — so a user who
  installed Claude Code and this tool together was told "No MCP clients found
  on this machine" with `claude` on PATH, handed JSON to paste by hand, and
  `claude mcp list` stayed empty. A client whose command is on PATH now counts
  as installed; when its file is missing, `connect` creates it holding only
  our entry (0600), which Claude Code accepts as a user-scope registration.
  Doctor's `mcp-clients` line names the installed-but-unregistered client
  instead of a generic "not registered". Seen on the cold-install walk.

- **`configure` writes its config where every later command can find it.**
  It wrote `./config.yaml` into whatever directory it was run from, and
  lookup stopped at the current directory, so a config written from `~` was
  invisible to `doctor` or `dispatch` run inside a project — "0 configured
  route(s)", no hint why — while the MCP client, handed the absolute path,
  saw it fine. The default target is now the state directory
  (`~/.harness-dispatch/config.yaml`, or under `HARNESS_DISPATCH_STATE_DIR`),
  lookup falls back to that file after `./config.yaml` (a per-project file
  still wins), `connect` looks in the same place, and doctor's `config` line
  names the file it loaded. `--config` and `HARNESS_DISPATCH_CONFIG` are
  unchanged. Seen on the cold-install walk, where a run from `/` produced
  `/config.yaml`.

- **`doctor` now notices a Codex that is installed but not logged in.** A
  ready route meant "the CLI is on PATH", so a never-logged-in Codex passed
  routes, billing and safety, and the first dispatch failed with a raw OpenAI
  `401 Unauthorized ... Missing bearer` that never mentioned `codex login`.
  A new `harness-login` check asks `codex login status` and fails with the
  command to run when it answers "Not logged in". The CLI is asked rather
  than its credential file read, because Codex accepts a ChatGPT login or an
  API key and honours its own home directory, and only its own answer is
  right in every case. Any answer other than a definite "Not logged in" —
  an older Codex without the subcommand, a spawn failure — is reported as
  undetermined and does not fail the install. Codex only: the other
  harnesses have no equivalent subcommand this tool has verified.

- **The installed command did nothing on Linux and macOS.** `npm install -g`
  puts `harness-dispatch` on PATH as a symlink to `dist/bin.js`, and node
  hands that unresolved link path to the program, so a run-if-entrypoint guard
  that only looked for a filename ending in `bin.js` decided it was being
  imported, ran nothing, and exited 0. Every documented command — `configure`,
  `doctor`, `connect`, `dispatch`, even `--help` — printed nothing and reported
  success on every non-Windows `npm install -g` or `npx` since the first
  release. Windows was unaffected only because npm's `.cmd` shim passes the
  real file path. The guard now also accepts an invoked path that resolves to
  this file. Found by walking the README's three install steps in a clean
  container, which nothing before had done: every prior walk ran `node
  dist/bin.js` on this Windows machine.

- **SECURITY: workspace paths are now built and verified rather than checked
  and trusted.** Four consecutive releases patched a guard that inspected a
  path STRING and then let every later write re-resolve it, and each patch was
  found incomplete by the next review: it followed the link it was checking,
  then covered one of the two isolation policies, then only the last path
  segment, then stopped one directory short of the one the release notes named
  — and was silently inert altogether if the workspaces setting had a trailing
  slash or a `..` in it. Validating once also left the rest of the dispatch
  trusting the result, so swapping a directory for a link mid-copy redirected
  it.

  Every directory from the anchor down is now created by this tool with a
  non-recursive `mkdir`, which cannot traverse a link it did not make, and the
  verified path is returned and used instead of being re-derived. Destructive
  operations re-verify immediately before acting. The symlink refusal now
  applies on Windows too, where junctions need no privileges and were being
  followed.

  Verified as two separate users on Linux across every shape reported: a link
  at the workspace root, at the base, at the base's parent, and with the
  setting spelled with a trailing slash or `..` — all refused, with nothing
  written into the attacker's directory. Legitimate use is unaffected,
  including a symlinked temp directory, which is normal on macOS.

- **A delegated "run the tests" task no longer blocks its own route.** The
  rate-limit phrase check ran against the whole transcript with no filter, so
  this project's own test output — which names rate limits in test titles —
  flagged as a real limiter, tripping the breaker for 300 seconds and
  recording a rate limit that never happened. It is now checked per line and
  past the same filter the numeric check uses.

- **Real limiter messages that were being missed now register**, including
  Anthropic's `rate_limit_error` and OpenAI's "You exceeded your current
  quota" wording. A missed limit is the worse direction: the router keeps
  hammering a route that has already said stop.

- A metered route that declares it cannot bill you is no longer told to allow
  paid usage. The previous release put that advice in a branch such a route
  never reaches, so it worked for local routes only.

- The claims checker now also scans MCP resource descriptions, every
  route-refusal message, the rendered status body and the CLI's own help text
  — surfaces a user or agent reads that it could not see.

- **SECURITY: the workspace symlink guard covered one of the two isolation
  policies.** The previous release applied the `lstat` refusal, the
  guard-before-prune ordering and the sweep's name check to `copy` only.
  `git_worktree` kept all three defects, so the identical attack still
  destroyed data — reproduced as two real users: `copy` refused, `git_worktree`
  deleted the victim's directory and raised the guard's error afterwards. The
  entry claiming the class was closed was true for one policy and false for the
  other. The test shipped with it passed `policy: "copy"` only, so the suite
  stayed green over a live vulnerability; it now runs against both.

- **The same guard only checked the last path segment.** `<tmp>/harness-dispatch`
  and `<tmp>/harness-dispatch/workspaces` are fixed names under a
  world-writable directory and were never examined, so a link planted one or
  two levels up redirected the whole copy into an attacker's tree. Every
  segment from the workspaces base down is now checked for links and ownership.

- **A rate-limit regression from the previous release.** The filter added to
  stop false positives discarded any line containing "should", which threw away
  real limiter messages — a missed 429 means the router keeps hammering an
  exhausted route. Two other patterns in that filter could never match at all.

- **A free local route is no longer told it can bill you, with a fix that does
  nothing.** A route with a declared kind and `paid_usage_possible: false` is
  blocked when its `billing_confidence` is `unknown` — deliberate — but was
  shown "route can incur paid usage" beside `paid=no` and advised to set a
  field it already had. It now names the real cause and a remedy that works.

- The `usage` tool description and README told agents that `service` and
  `models` are unvalidated. Both throw on an unknown route id. The same wrong
  sentence was corrected in the plugin skill one release earlier and missed
  here — `scripts/check-claims.mjs` could not see tool descriptions at all, and
  now does.

- `scripts/fetch_benchmarks.py` no longer replaces good benchmark data with its
  bundled fallback when the network fails. It swallowed every exception,
  returned an empty set, wrote it out and exited 0 — turning a transient outage
  into a permanent downgrade of the file that ships in the package.

- An env-var reference embedded in a larger value (`base_url:
  https://${HOST}/v1`) is now stripped from spawned CLI environments. The
  sanitizer anchored to whole-string matches, so a key inside a longer string
  stayed visible — the exact leak it was written to close, one string shape
  over.

- `OPERATIONS.md` described streamed fanout wrongly (its arms DO create jobs,
  and are not aborted on disconnect), `safety.ts` claimed every shipped harness
  defines all three safety profiles (`cursor_cli` declares one),
  `ux-walkthrough.md` called `discard` the only destructive operation (the
  retention sweep is the one that deleted files), and two module headers said
  three tools where six are registered.

- **SECURITY: a `copy` dispatch could delete files outside its workspace.**
  The ownership guard used `stat`, which follows symlinks, so it compared the
  uid of whatever a link POINTED AT rather than the link's own — and on a
  shared machine the workspace path is predictable, so another local user can
  plant one. Worse, the retention sweep that deletes aged workspaces ran
  BEFORE the guard and had no ownership, marker or name check of its own.
  Reproduced end to end in a container: a victim's directory chmod'd, the
  project copied into it, and their files removed. All three now fixed —
  `lstat` with symlinks refused outright, the guard runs before anything
  destructive, and the sweep only deletes directories matching the name shape
  this tool generates. The previous release's entry claiming a foreign-owned
  root was "refused outright" was false against exactly this attack.

- **Non-ASCII output was being corrupted.** Every stdout chunk was decoded on
  its own, so a character split across two reads became replacement
  characters — accented text, CJK, emoji, box-drawing. This is the path every
  job uses, so it reached partial output, saved logs and delivered results,
  and was invisible to anyone working in English.

- **An aborted streaming request now stops the run.** Nothing connected the
  client disconnect to the dispatch, so an abandoned stream ran to completion,
  spending quota — and being the one path with no job record, it could not be
  cancelled either. On a CLI route that meant an agent still editing files for
  a caller that had gone.

- **HTTP fanout with no eligible route now refuses** instead of answering 200
  with an empty list. CI and cron read 200 as success; the MCP surface already
  refused the identical request by name.

- A configured `timeout_ms` now covers reading an endpoint's response body,
  not just its headers — the same defect as the leaderboard timeout fixed last
  release, in the path the router uses for its primary route.

- Endpoint credentials can no longer leak through streaming error text: undici
  embeds the request URL, and this branch returned it unscrubbed while its
  sibling scrubbed it deliberately.

- A rate-limit false positive no longer trips the breaker on text ABOUT a 429
  — a line number, or a test assertion the delegate ran. One flag blocks a
  route for 300 seconds and records a limit that never happened.

- Config hot-reload now notices a config whose timestamp moves BACKWARDS
  (restored from a backup, `cp -p`, extracted from an archive), and documents
  the two cases where it does nothing at all.

- The MCP snippet `configure` prints is now the entry `connect` actually
  writes. Pasting the documented snippet then running `connect` was answered
  "has an entry we did not write" — the tool called its own output
  hand-edited and refused to update or remove it.

- The chained-context omission notice named the wrong jobs when a job id
  repeated, listing ones whose output was directly above it.

- **An existing `copy` workspace directory is now actually secured.** The
  previous release set 0700 with `mkdir`'s `mode` option, which applies only to
  directories it CREATES — so everyone who had used `copy` before kept a
  world-readable root holding a full copy of their source, and the entry
  claiming otherwise was wrong. Measured on Linux: 0755 before, 0755 after. An
  explicit chmod fixes them. A root owned by ANOTHER user is now refused
  outright rather than copied into: the path is deterministic inside a shared
  temp directory, so on the multi-user machine this guard exists for, someone
  else can create it first.

- **A half-dead leaderboard endpoint no longer hangs every dispatch.** The 8s
  timeout was cancelled as soon as response headers arrived, leaving the body
  read unbounded — measured still pending after 15s. Quality scores are awaited
  per routing candidate, so this stalled routing indefinitely. Off by default,
  which is why it was not worse.

- **The HTTP server no longer leaks an MCP server per rejected request.** A
  request carrying an unknown session id is answered 400 without initialising,
  so nothing ever closed the server built for it in advance — five such
  requests left five alive until shutdown. Sessions are also expired after 30
  minutes idle: nothing removed them before except an explicit HTTP DELETE,
  which the standard client never sends, so a clean shutdown left its session
  resident forever.

- **`retry_job` on an abandoned job no longer races the original.** Its guard
  read the derived status while the claim path reads the raw status file, so a
  supervisor could pick up the original while the retry ran — the exact outcome
  the command's own error text says it prevents. The original is now marked
  cancelled.

- **Chained context says what it left out.** Jobs past the character budget
  were dropped with no header and no note, contradicting the contract stated in
  the same file. The docblock also claimed oldest entries truncate first, which
  was never true — the last ones go.

- The `copy` size refusal named the parent of your project rather than the
  workspace holding the work, and the `force` flag's description still promised
  an uncommitted-changes refusal that only exists inside a git repository.

- **`configure` no longer deletes `detect: false`.** That key is the only
  setting that isolates a machine from its installed paid CLIs, and it had no
  field on the internal config object, so regenerating a file silently dropped
  it. Measured: `detect: false` plus `max_concurrent_runs: 2` came back as the
  latter alone, and reloading it with all four harness CLIs present produced
  four routes on real subscriptions — under a "Wrote" message. A bare
  `detect: false` regenerated as an empty document, where even the
  "this config defines no routes" warning is suppressed, because its trigger
  requires a non-empty file. `detect` now round-trips, and is written only when
  the file stated it — carrying the resolved value would stamp `detect: true`
  into every config that merely omitted it.

- **`connect --remove` now removes the entry.** Without `--clients` it printed
  "our entry is here — will be removed", exited 0, and left the file
  byte-identical. The chooser filtered out plans whose entry already matches —
  correct when registering, and exactly backwards when removing, where a
  matching entry is the one being removed. `--clients` bypassed that function
  and always worked; the broken form is the one documented in README and
  OPERATIONS.md. A hand-edited entry is still refused without `--force`, and
  now exits non-zero rather than reporting success for work it did not do.
  This command had no test coverage at all; it does now.

- **The test suite can no longer reach a real route.** Test setup already
  sandboxed the log, state and jobs directories — where the suite WRITES — but
  not config, which is what it DISCOVERS. A test that loaded config without
  naming a file or stubbing detection picked up whatever the developer's
  machine offers. Measured while closing this: on the maintainer's machine
  that is the repo's own `config.yaml`, yielding four API routes with real
  keys; on a machine with the CLIs installed it is the harness fleet, on real
  subscriptions. One boundary test really did dispatch to Claude Code on every
  CI run once. Setup now pins `HARNESS_DISPATCH_CONFIG` at a `detect: false`
  sandbox, so an un-stubbed load gets an empty route table; a test wanting
  routes passes its own path, which still wins.

- **An orphaned job can be cancelled again — when it is still able to run.**
  There are two kinds: one written to disk when the server exits before a
  queued job starts (genuinely terminal), and one DERIVED from a stale
  heartbeat while the file still says `queued`. The second is not inert — a
  supervisor reclaims it once the dead owner's claim ages out — and `cancel`
  answered "had already finished; nothing to cancel" about work that could
  still start, leaving no way to stop it. It now settles the status itself,
  since an orphaned job has no runner to notice a marker. The written kind
  still reports nothing to cancel.

- **A `copy` workspace of many files can no longer build an unbounded patch.**
  The per-file diff was already bounded; the concatenation of those files was
  not, so files each under the limit still summed past it. Both limits now
  explain themselves — the worktree path used to surface the cap as
  `stdout maxBuffer length exceeded`, which says nothing about patches or
  about the work still being safe on disk.

- **Isolated workspaces are created 0700**, like the state and job
  directories. A `copy` workspace holds a full copy of your source and the
  default base is in the shared temp directory, so on a multi-user POSIX
  machine it was readable by everyone. No effect on Windows.

- **Chained context says which project it came from.** `contextJobs` inlines
  any job from the machine-wide store with no working-directory scoping, so a
  job from one project could be pulled into a dispatch for another with
  nothing indicating it. Disclosed rather than blocked: chaining across
  projects is legitimate and the caller passes the id explicitly — what was
  missing is that nobody could see it happen.

- **Dead supervisor heartbeats are swept.** A killed supervisor's file stopped
  being counted but stayed forever, and the liveness check reads every file on
  every drain. The sweep is limited to heartbeats: the crash log beside them
  exists to explain the very supervisor that died.

- `workspace apply`'s description no longer claims a refusal it cannot always
  make: the uncommitted-changes check needs a git repository. Outside one,
  only the per-file check applies — a file the patch touches is still
  refused, unrelated edits cannot be seen.

- A `timeout_ms` or token-cap warning no longer claims routing reads the
  field. Routing does not; the range branch was fixed for this and the
  not-a-number branch beside it was not.

- **Usage counters are no longer silently lost when two dispatches finish at
  once.** `withFileLock` runs its critical section unlocked after a 2s
  timeout — deliberate, and still right for the circuit breaker, which has
  nothing to fall back on. It was wrong for the quota counters, which keep a
  pending delta and clear it only on success: an unserialised write landed,
  the delta was cleared as though serialised, and the process actually holding
  the lock then overwrote the file with a value computed before that write
  existed. Reproduced against the built artifact: five recorded calls gone,
  no error. The counters now defer instead, and the delta lands on the next
  result. A busy moment is no longer reported as "counters not reaching
  disk" — they are delayed, not lost, and saying otherwise makes a working
  system look broken.

- **A route knocked out by a 429 no longer reports `tripped: true,
  failures: 0`.** `trip()` set the cooldown without counting the failure, so
  `usage` — the surface an orchestrator is told to consult before delegating
  — showed a contradiction that reads as a bookkeeping bug rather than a real
  trip.

- **Discarding a workspace whose directory is already gone now clears the
  registration git is still holding.** The early return skipped the block that
  removes a worktree through git, so a workspace pruned by retention or
  deleted by hand left `.git/worktrees/<name>` in the user's repo
  permanently — the exact outcome `discardWorkspace`'s own documentation says
  it exists to prevent. Reproduced: `git worktree list` still showing the path
  as `prunable` after discard reported success.

- **An orphaned or cancelled job now hands back its partial work through the
  tool an orchestrator actually calls.** The progress was on disk and
  `getAsyncJob` read it, but `job_status` answered `output: ""`: orphaned and
  cancelled count as terminal, and the poll response attached `partialOutput`
  only on the NOT-terminal branch. So a commit titled "an orphaned job hands
  back its progress" was correct in the module it edited and had no effect at
  the surface a caller touches — verified at the function, not at the tool.
  The crash path (a `failed` status with no result) was losing its output the
  same way. The HTTP surface already salvaged this; MCP now matches it, and
  the answer says the output is PARTIAL so salvage is not read as a result.

- **A gitignored file the agent wrote is no longer reported as applied while
  being left behind.** Under `git_worktree`, the patch came from `git add -A
  -N`, which obeys `.gitignore`, while the changed-file list came from a
  filesystem fingerprint, which does not. A job that wrote a `.env` or any
  ignored file got `applied: true` naming it, with the file absent from the
  patch and from the project. It compounded: the already-applied guard needs
  every recorded change present, so it never fired, and the next apply refused
  with "changed since dispatch" — blaming the caller for the first apply's own
  writes, the misleading refusal an earlier fix had removed. The paths already
  recorded as changed are now force-added, which also makes `git_worktree`
  agree with `copy`, whose per-file patch always carried them.

- **`clis: []` now isolates a config, which is what the previous release said
  it did.** Authoritativeness keyed off a NON-EMPTY list, so the most explicit
  way to write "no CLI routes" still loaded every harness on the machine —
  the exact failure the change was written for, described in its own comment
  in the past tense while remaining true. Presence of `clis:`/`endpoints:` is
  now what makes a config authoritative, empty or not. A config that mentions
  neither still auto-detects, unchanged.

- **An infinite or NaN route field is no longer accepted, and the warning
  about it is no longer false.** The new range check covered negative values
  but not `.inf`, `.nan`, or `1e999` (which YAML types as a string, and
  `Number()` overflows to `Infinity`). Two paths were wrong: `1e999` produced
  no warning at all, and `tier: -.inf, weight: .inf` loaded as
  `-Infinity`/`Infinity` — ahead of every tier, above every score —
  underneath a warning reading "IGNORED, and the built-in default applies
  instead". A message asserting the opposite of what happened is worse than
  the silence it replaced. Warnings also now name the value the operator
  actually wrote (`JSON.stringify(Infinity)` is `null`, so they reported
  `tier is null` for a file saying `-.inf`), and explain the right mechanism
  per field rather than describing routing for `timeout_ms`.

- **`configure` no longer generates a config that fails its own `doctor`.**
  It carried `disabled:` forward alongside the `clis:` it generates; in an
  authoritative config that control does nothing, so `doctor` reported it had
  no effect and exited 1. The disabled route is already absent from the
  generated list, so the name was saying nothing. It is still emitted for a
  generated config that lists no routes, where it does the work.

- **A `clis:` or `endpoints:` written as a mapping instead of a list now
  says so.** The entries vanished, the config counted as defining no routes,
  detection ran, and someone trying to name their own routes silently got
  every installed paid harness instead — under a warning claiming their
  config defined no routes, which contradicted the file in front of them.

- Legacy `services:` configs now get the same top-level key warnings as the
  modern shape. That path returned before the check ran, so `policy: copy`
  warned twice in one format and not at all in the other.

- **A negative `tier`, `weight` or `cli_capability` no longer hands a route
  every dispatch.** These were type-checked but never range-checked, and
  routing multiplies `weight` and `cli_capability` into the score while
  ordering `tier` ascending — so a negative pair does not demote a route, it
  promotes it past every legitimate one. An acceptance pass measured
  `tier: -5, weight: -100, cli_capability: -3` scoring 299.8 against a normal
  route's 0.88, from a tier sorting ahead of them all, with no warning
  anywhere. Out-of-range values are now reported and ignored, so the built-in
  default applies — the same outcome an unreadable value already got. Upper
  bounds were deliberately not added: `cli_capability: 1.1` ships in this
  repo's own default config as real tuning, and the defect is sign, not
  magnitude.

- Top-level `policy:` and `workspace_policy:` now say they have no effect.
  Both were allow-listed and read nowhere — and both ARE valid per-route keys,
  which is what makes the top-level spelling easy to write: it looks like a
  global default for the per-route setting, and there is no such default. An
  isolation control that silently does nothing is the failure the config
  validator exists to prevent. The per-route keys are unaffected.

- An `execute` task can no longer be routed to an HTTP endpoint. An endpoint
  has no agent loop, no file access and no shell — PRODUCT.md states this as
  design rather than gap — but an undeclared capability defaults to 1.0 and no
  endpoint example declares any, so endpoints scored PERFECT for execute. An
  acceptance pass measured a `--task-type execute` dispatch routed to an
  endpoint, returning prose with exit 0: execution reported as succeeded when
  none happened. It surfaced exactly when the CLI routes were busy or tripped,
  which is the case a caller is least able to check.

  Refused outright rather than scored low, on both counts deliberately: a score
  of 0 still leaves a route selectable when it is the only candidate — the
  failing case itself — and a declared capability must not override it, the
  same rule as the safety-flag check. Endpoints remain full members of the mix
  for plan, review and second opinions.

- An orphaned job now hands back the progress it saved. When a supervisor dies
  there is no result, but its output is on disk in `stdout.partial.log` — and
  the orphan branch returned above the code that reads it, so the response was
  empty while the trail sat there. Chaining had the same gap, reporting "no
  result available" for a job whose partial output was recoverable; it now
  carries that output, labelled INCOMPLETE. PRODUCT.md names losing this trail
  as the defining failure: "a wasted attempt with no trail".

- HTTP fanout arms are now job-backed, like the MCP surface has always been.
  They called `routeTo` directly, so an arm's work existed only inside the
  request — no job directory, no manifest, no partial log. Killing the client
  or the server mid-fanout lost every arm's output with nothing on disk to
  salvage, which is the failure PRODUCT.md names as defining, on one of two
  surfaces.

  The response shape is unchanged: arms are awaited and the same rows are
  returned, so an OpenAI-compatible client sees exactly what it saw before.
  Each row additionally carries the arm's `jobId`, which is what makes salvage
  possible. This was briefly recorded here as deferred "because it changes what
  a client receives" — that was wrong, and re-reading the MCP path showed why:
  durability and the response contract are independent.

## [0.8.0] — 2026-08-31

### Added

- `GET /health` — liveness on the HTTP surface, and the only route served
  without a token. Every endpoint required the bearer token, so a deploy gate
  or container probe could not ask whether the process was up without being
  handed a credential, and a health check that needs a secret is one most
  orchestrators will not perform. It answers `{"status","service","version"}`
  and nothing else; `/v1/status` keeps the richer answer behind the token.

- `OPERATIONS.md` — the signals worth watching, what there is to alert on (and
  honestly, that there is nobody to page for a tool that runs on one laptop),
  the failure modes that have actually happened here, and how to recover from
  each.

- `harness-dispatch connect` registers this server with the MCP clients on your
  machine, and `configure --yes` now offers it as the last step of setup instead
  of printing JSON for you to paste. `connect --remove` takes the entry back out.

  Setting this up was a copy-paste job that nobody owned, and the paths in it
  later moved. On the maintainer's machine that produced, simultaneously: a
  Claude Code entry launching a directory renamed away months earlier, a session
  hook pointing at the same dead path, and a working Cursor entry with no
  `--config` — so the two clients disagreed about which routes existed while
  both appeared to work.

  Careful with other applications' files, because this project has already got
  this wrong once (v0.1.0's setup wrote instructions and a hook; v0.2.0 removed
  the command and left both behind for seven minor versions). Only the two
  config shapes actually opened on a real machine are written. Every write is
  backed up next to the file, merged rather than replaced — other servers and
  our own entry's `env`, which holds live API keys, are preserved — and swapped
  in atomically after being parsed back, so a half-written `~/.claude.json` is
  not a possible outcome. An entry that already exists and differs is shown and
  left alone unless you say otherwise; that Cursor entry was the working one.
  Re-running changes nothing. With no terminal and no `--clients`, it reports
  what it would do and writes nothing rather than prompting into the void.

  `connect --dev` registers the checkout you are running instead of the
  published package, for anyone developing against this repo. Without it that
  case is not merely unsupported but actively wrong: on a machine with nothing
  installed globally, the package form resolves through `npx` to whatever is on
  the registry, so registering it swaps a checkout that is commits ahead for an
  older release and reports success. Found by running `connect` on the
  maintainer's machine, where it correctly declined to do exactly that. The
  trade — an absolute path breaks silently when the directory moves — is why it
  is opt-in per run, prints the path before writing it, and leans on the
  `doctor` check that already fails on a client entry naming a path that has
  gone.

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
  that did. Codex has always used stdin. A 21,670-character prompt — 2.65x the
  8,191-character ceiling — refused outright by the old form, now dispatches and
  answers.

### Fixed

- The CLI no longer aborts with exit 127 after printing a correct answer. A
  routed fallback — the first route answering but unusably, the second
  succeeding — ended in a libuv assertion on Windows and an exit status every
  shell reads as "command not found". The work was done and the report of it
  was a crash. Three acceptance passes reproduced it 3/3 and it was the oldest
  confirmed defect here; the cause was tearing the event loop down with
  `process.exit()` while two HTTP connections were still closing. Verified at
  the built binary: 127 with the assertion on all three runs before, 0 with
  none on all three after.

- `base_url` values with a path of their own are no longer mangled. `/v1` was
  appended to anything not already ending in it, so this project's own
  documented `https://generativelanguage.googleapis.com/v1beta/openai` became
  `/v1beta/openai/v1/chat/completions`, which Google does not serve, and an
  `anthropic_messages` host on a non-`/v1` path was unconfigurable. A bare
  origin still gets `/v1`; a path you supplied is now used as you wrote it.

- `configure` writes `config.yaml` with 0600. It can contain a literal
  `api_key` — `configure` deliberately preserves one rather than replacing it
  with a `${VAR}` reference — and it was written with default permissions,
  0644 under a typical umask, in a module family that is careful everywhere
  else. POSIX only; Windows ignores the mode.

- Usage counters that cannot reach disk now say so. The in-process view kept
  serving the numbers it had accumulated, so nothing looked wrong until the
  next restart showed every count at zero, with `usage` reporting them as fact
  in between. Reported under `status`'s "State problems", never thrown: a
  dispatch that produced a real answer must not fail over a counter.

- `doctor` reports unreadable saved state. It read the config warnings
  directly, so a corrupt breaker record or unwritable usage counters were
  invisible to it — eleven green checks over state it could not read. `status`
  grew a heading for this and `doctor` had not followed.

- Two messages that reached the right conclusion by the wrong description: a
  route blocked because its billing CONFIDENCE is unknown was told "billing
  source is unknown", for a route `status` prints as `billing=metered_api`;
  and `doctor` described a dead `--config` path as somewhere the client
  "launches from".

- The test suite no longer dispatches to your real subscription harnesses.
  Config entries are additive, so a test config declaring empty CLI and
  endpoint lists did NOT isolate it from the harnesses installed on the
  machine — and one boundary test reached the real Claude Code CLI on every
  `npm test`, every `npm run check` and every CI run, spending quota to prove a
  schema check. An acceptance pass measured it: 6.4 seconds, 47k input tokens.
  The test carried a comment asserting the opposite, which nobody had checked.
  Verified fixed by measurement rather than by reading — the dispatch log stood
  at 425 lines before a full run and 425 after.

- A mistyped safety setting no longer gets you MORE access than you asked for.
  `safteyProfile: "read_only"` at the top level of an MCP call was accepted in
  silence and the dispatch then ran at the `workspace_edit` default — an
  acceptance pass measured it writing a file into the project. The HTTP surface
  had refused the same input all along, so one input got two opposite answers.

  It could not be fixed in the schema: the MCP SDK validates arguments before
  any handler runs and discards unknown keys, so nothing downstream could see
  what was sent. `hints` is strict, which is why the nested form was always
  caught; the outer object cannot be, because MCP carries its own `_meta`
  there. The fix wraps the SDK's tool-call handler and inspects the raw
  arguments before delegating, leaving routing, validation and progress
  reporting untouched. Both surfaces now run one shared check, and the parity
  suite asserts it on both rather than recording the difference as deliberate.

  The refusal says WHERE the key belongs, per key and per surface, because the
  two differ: the HTTP surface reads all seven hint names from the top level of
  the request, while on MCP only two are top-level and the rest go inside
  `hints`. A single "did you mean X?" sent the caller to a second rejection -
  the same failure this project already recorded from its snake_case traps, "a
  refusal that confidently points at the wrong landing spot costs the round
  trip it exists to save". On the five tools that take no hints at all the
  message says so, rather than warning about access it cannot grant.

- An endpoint credential embedded in `base_url` no longer reaches the terminal
  or `logs/dispatches.jsonl` through an error message. The redaction only ever
  cleaned URLs this code assembles; Node embeds the URL it was handed inside
  its OWN exception text, which was then passed through verbatim with a
  redacted URL appended beside it — the two forms side by side, under a comment
  promising the result was safe to paste into a bug report. Userinfo, query
  values and the host are now removed from wrapped messages too.

- Applying the same `git_worktree` job twice now says "already applied"
  instead of accusing you of a conflict with your own apply. That answer lived
  only on the empty-patch path, which a worktree patch never reaches — it is
  `git diff <baseCommit>` inside the worktree, so it does not empty out the way
  a rebuilt `copy` patch does. The second apply fell through to the conflict
  check, which saw the file differ from its recorded base (the difference the
  first apply had just made) and pointed the user at `force: true`. The
  walkthrough says both policies answer "already applied"; only one did.

  The refusal message also claimed "unlike a worktree patch there is no common
  commit for git to merge against" — while refusing a worktree patch, which
  has one. That clause now appears only for `copy`, which it describes.

- `workspace apply` no longer refuses on a clean tree when the dispatch ran in
  a SUBDIRECTORY and `HARNESS_DISPATCH_WORKSPACES_DIR` points inside the
  project. `git status` prints repository-root-relative paths; they were being
  resolved against the dispatch directory, so the workspaces folder failed to
  match and read as your uncommitted work. The same defect fixed at the repo
  root a day earlier, surviving one level down.

- A `git_worktree` dispatch now explains the three ordinary ways it cannot
  start — no git on PATH, not a git repository, no commits yet — instead of
  handing back raw git internals with no route taken. A freshly initialised
  project is a normal state, not an error.

- The streaming HTTP surface no longer emits an SSE `error` frame for a route
  failure that a fallback then recovers. The frame was written the moment a
  route failed, before the next route had been tried, so a request that
  SUCCEEDED still carried an error ahead of its own answer. The OpenAI
  streaming contract has no non-fatal error frame, so a client treating one as
  terminal reported a failure for a request that worked. The frame is now held
  and sent only if nothing succeeds.

- A route reporting only `remaining` in its rate-limit headers no longer wipes
  the limit already known for it. Both fields were assigned under a guard that
  only asks whether EITHER arrived, so a partial update nulled the limit — and
  with no limit there is no ratio, so the quota score went back to a full
  1.0. A route with two requests left scored the same as an untouched one, and
  the router preferred it. Headers are a partial update, not a replacement.

- An unreadable `quota_state.json` is now moved aside rather than replaced.
  "No file yet" and "a file I could not read" both produced an empty map, and
  the caller applies its delta to that and writes the result back — so a single
  bad read did not merely stop counting, it REPLACED every route's history.
  Measured: two routes at 5 and 3 calls became one route at 1, with `usage`
  reporting that as fact. Counters are informational, so this does not try to
  recover them; it declines to be the thing that destroys them.

- A fanout where NO route can run now errors instead of answering
  `completed: true` with an empty results array. `completed` is `every()` over
  the arms, so zero arms was vacuously true, on the field the tool description
  tells agents to branch on. An unknown route NAME already errored, so the same
  mistake produced two opposite shapes depending on whether the route named
  happened to exist and be disabled. The error names each route and why.

- `connect` no longer rewrites a client config whose shape it does not
  understand — at any level, not just the outermost one. "Does it parse" and
  "is it the shape I am about to merge into" are different questions and only
  the first was asked, so an array-rooted file came back as
  `{"0":…,"1":…,"mcpServers":{…}}` with success reported.

  The first version of this fix guarded the JSON root alone, and an acceptance
  pass the next day found `{"mcpServers":"oops"}` still having its string
  rekeyed the same way — the same defect one level down. The question is now
  asked wherever this spreads: the root, the servers map, and our own existing
  entry. A backup was always taken, so both were recoverable, but this writes
  another application's config, which is the highest-consequence thing here.

- `workspace apply` no longer overwrites a file you wrote and committed
  yourself, when the agent CREATED a file at the same path. The conflict check
  compares each touched file against how it looked when the dispatch started;
  an added file has no such record, because it did not exist — and every change
  without one was skipped, so the protection was simply absent for the change
  kind that creates new files. Its ABSENCE is the base: if the path is there
  now, the project gained it. This is verbatim the failure the check was added
  for, live for one of the three change kinds, and committing your work is what
  the dirty-tree refusal tells you to do. `force: true` still overrides.

- A route can no longer claim a safety profile it has no flags for by pinning
  `effective_safety`. The pin returned before the flag check ever ran, so a
  route declaring `effective_safety: read_only` while defining flags for only
  `workspace_edit` launched its harness with no safety argument at all, reported
  `read_only` everywhere including the audit log, and wrote a file into the
  project under a read-only dispatch. The flag check now runs first — nothing
  declared can conjure a flag that does not exist. A pin is still honoured for a
  route that is not flag-controlled at all, which is the case it exists for. The
  shipped harnesses are unaffected. Found by an acceptance pass, which also
  found the test pinning the old behaviour describing a fixture it did not have.

- A `copy` workspace now SAYS which directories it left out. `bin`, `dist`,
  `build`, `target`, `obj` and `.venv` are excluded by name as build output —
  and are real source directories in some projects. The omission was invisible
  on every surface: the agent reasoned from an incomplete tree, and a change to
  an excluded file could not appear in the patch or the changed-file count.

- `workspace apply` no longer refuses on a clean tree when
  `HARNESS_DISPATCH_WORKSPACES_DIR` points inside the project — the
  configuration README recommends, for reflinks. Only the legacy hard-coded
  `.harness-dispatch` name was filtered from the dirty check, so the configured
  workspaces root read as your uncommitted work and blocked every apply.

- A failed config hot-reload now reaches `status`, under a `State problems`
  heading, instead of only stderr — which no MCP client and no HTTP caller ever
  sees. The comment at that code described the bug as "nothing on stderr and
  nothing in status" while closing only the first half. Breaker warnings moved
  to the same heading: they were filed under config warnings, which says "these
  change behaviour" and means ignored config entries.

- `workspace` operations with `git` missing from PATH now say that, instead of
  `spawn git ENOENT`.

- `safeEqual` in the HTTP auth path did its length-mismatch comparison against
  the caller-supplied buffer, so the work scaled with a length an attacker
  chose while the comment claimed the opposite. Not reproduced as an
  exploitable signal, and the result was always correct.

- An endpoint that answers HTTP 200 without an answer is now a failure on both
  request paths, not a successful empty answer. A success heals the circuit
  breaker, so a route serving nothing but empty 200s was recorded as healthy
  indefinitely and never tripped.

  The streaming path — the only one `dispatch` and `job_status` ever take, so
  the surface an orchestrating agent branches on — reported `success: true`
  with an empty output for a body carrying no content at all. The buffered path
  (what the CLI uses) refused that one, but accepted a well-formed response
  whose `content` was the empty string, returning success with nothing in it.
  Both now refuse both, which is what makes the two surfaces agree; an earlier
  entry here claimed the buffered path already refused empty answers, and that
  was wrong.

  Both paths now answer the same two questions in the same order, in one
  shared function so that the agreement is enforced rather than asserted: was
  the body readable, and did any bytes arrive? A read that FAILED is reported
  as a failed read — saying "no body" there would be a claim about what the
  server sent, and a reset connection is not evidence of it. Otherwise the
  body is quoted if one arrived, and reported as absent if not. The dispatcher
  does not try to work out WHY a response was unusable.

  Two earlier versions did try, and each was wrong in ways only an acceptance
  pass found. The first called anything that produced no text "no content", so
  an HTML error page, plain prose and a gateway that ignored `stream: true`
  were all described as empty. The second tested whether the body looked like
  SSE, and got three more cases backwards: a stream in a dialect the route was
  not configured for had its real answer thrown away and called empty; SSE
  comment keepalives — which a real provider sends while thinking — were
  called an unexpected shape; and an HTML page containing any `data:` line was
  called empty. Worse, the same body was described two different ways
  depending on how the network happened to split it.

  A well-formed but empty stream now quotes its own terminator instead of
  being described in nicer words. The message says only that no answer came
  out of the body and shows what did arrive; it does not call the shape
  unexpected, because a stream that carried nothing had exactly the expected
  shape.

  Reproduced by acceptance passes.

- A corrupt circuit-breaker record is now reported as unknown state instead of
  rendering as a healthy route. `status` said `breaker=closed failures=0` — an
  assertion the process had no basis for — and a single bad file therefore
  un-tripped a live cooldown in silence, which is the exact failure this
  persistence layer was added to prevent.

  Rather than enumerate the ways a record can be corrupt — a list acceptance
  passes kept finding entries missing from — this checks the invariant the
  module already holds: a healthy route has NO file, because a healthy save
  deletes one. So a file that reads back fully healthy is a contradiction, and
  that catches the `[]`, `{}` and foreign-schema records a list of type checks
  had missed, without having to name them.

  It does NOT catch everything, and an earlier version of this entry claimed
  it did. A record carrying a *deadline* is not fully healthy, so the
  invariant never looks at it — leaving a nonsense deadline to read as a
  normal route. Deadlines are now checked against what the code can actually
  produce: `snapshot()` emits `null` or `Date.now() + remaining`, capped at
  `MAX_COOLDOWN_SEC`, so zero, negative and far-future values were never
  written here. That last one matters most — an unchecked far-future deadline
  would have blocked a route for years rather than merely un-blocking it.

  What remains, stated rather than papered over: a corrupt deadline that
  happens to look plausible is indistinguishable from a real cooldown that
  has simply expired, because nothing rewrites the file until the route's next
  event. Type checks remain for a wrong-typed field on a record that is
  otherwise not-healthy. A field that is simply ABSENT is still tolerated,
  because older builds wrote fewer of them.

  The same validation runs on the pre-split `breaker_state.json` read during
  an upgrade, which had none of it: a bad entry there was coerced to healthy,
  skipped as nothing-to-migrate, and the file deleted — so upgrading, the
  moment a live cooldown is most likely to be sitting on disk, destroyed it
  silently. The per-route "healthy is a contradiction" rule cannot apply
  there, because the old format wrote healthy entries legitimately, so the
  shared validator gained a floor instead: a record naming none of the fields
  it understands is not one it understands. Without that floor, `{}` and a
  foreign schema — including the snake_case shape of the Python implementation
  this was ported from — still passed and were still destroyed.

  A blob is now rewritten with only the entries this could not consume, so
  each entry is read exactly once and the file disappears on a clean upgrade.
  Keeping the WHOLE blob whenever one entry was bad meant the good entries
  were replayed on every read, forever — recreating a per-route record after
  the route had recovered and its record was deleted, leaving it one failure
  from tripping and unable to heal.

  An unreadable record whose name is not a configured route (every corrupt
  blob, since it has no route name) is reported under its own `status`
  heading, separate from config warnings — nothing here was misconfigured or
  ignored, and `doctor` and the CLI's "ignored config entries" list both read
  the config warnings directly.

  The lost count cannot be recovered and this does not guess at it — failing
  closed would strand a route until someone deleted a file by hand. `status`
  says the saved state was unreadable and may be stale, in the text output and
  as `breaker.stateUnreadable` in the JSON. `doctor` does not report it.

- Workspace reclamation no longer deletes directories it did not create. The
  sweep added earlier in this cycle judged a directory by age alone, so pointed
  at a shared `HARNESS_DISPATCH_WORKSPACES_DIR` it would recursively delete
  anything sitting there untouched for a day. That override is not an obscure
  escape hatch — the README recommends it — and nothing said the directory
  would become this tool's exclusively. An acceptance pass reproduced the loss
  against the built artifact: two unrelated directories with real content
  destroyed by a single dispatch. Default installs were never affected, since
  the default base is dedicated.

  A directory is now reclaimed only if it carries a marker file this tool
  writes into every root it creates. The first attempt matched the generated
  NAME shape instead, `-[0-9a-f]{8}$` — and eight decimal digits are valid hex,
  so every `<name>-<YYYYMMDD>` still matched: a second acceptance pass planted
  `backup-20260401` beside the directories that now survived and watched one
  dispatch delete it recursively. A heuristic cannot answer "did I create
  this". Roots made before the marker existed are still reclaimed, but only
  when every child is a generated run directory and there is at least one, so
  the earlier disk leak does not return through the back door.

  The original test passed only because its fixture happened to be named
  `gone-project-deadbeef`, matching that shape by accident. It now has two
  companions that must survive: an ordinary directory, and one named to
  collide with the shape check that failed.

- Endpoint redaction actually redacts. `redactEndpointHost` replaced the
  hostname by assigning to `url.hostname`, and the WHATWG URL setter silently
  rejects a value containing `<` and `>` — so it returned its input verbatim,
  every time, while three call sites presented the result as scrubbed (one
  commented "safe to paste into a bug report"). An acceptance pass measured a
  failed dispatch reporting `https://api.secret-internal.example.com/v1?key=…`
  into both the error and the dispatch log. Userinfo, query and fragment are
  now dropped on every path including loopback, since a key embedded in a URL
  is a credential wherever the host points. It shipped inert because nothing
  tested it; it has tests now.

- `auth rotate` invalidates the old token for a running server. The token was
  read once at startup and held, so rotation was a lie in both directions: the
  old token kept returning 200 and the newly issued one was refused with 401 —
  measured. Invalidating the old value is the only reason anyone rotates a
  credential. The token file is re-read when its mtime moves, so the common
  path stays a stat.

- `connect` will not replace a client entry you edited by hand without your
  say-so. `connect --remove` always refused this; `connect` did not, so the
  protection existed on the half where the cost is lower — and `OPERATIONS.md`
  promised it for both. Running `connect` with no `--clients` shows the
  difference and asks; `--force` overrides. Naming a client is not consent to
  overwrite what is there.

- A job stranded in the slot queue by a server that exited is reported as
  orphaned instead of reading `queued` forever. Slot-queued jobs are exempt
  from orphan detection because nothing heartbeats for them, and the only
  things that drained the queue were a runner exiting or a new dispatch
  arriving. Reported, deliberately, rather than resumed: resuming was tried
  first and an acceptance pass demonstrated the cost — kill a server with a job
  queued, restart, and it runs to completion in its original working directory
  at up to `full_auto`, unattended, bounded only by the 7-day retention window.
  `retry_job` re-runs it as a decision.

  Only when no supervisor is alive to run it. The first version of this reasoned
  that a starting server means any queued job belongs to a dead session — false
  in the configuration this ships by default, where `connect` registers Claude
  Code and Cursor and `serve` is a third, all sharing one jobs root. Measured:
  with one server live and holding a legitimately queued job, starting a second
  marked it orphaned within a second and removed it from the drain queue,
  killing live work with an error stating a cause that was not true.

- A streamed request stops rather than falling back once any answer text has
  been sent. It fell back anyway and then discarded what the fallback produced:
  an acceptance pass measured an endpoint streaming `he`, `llo `, dying, and the
  fallback route succeeding with 49 characters the client never saw — produced,
  charged for, thrown away. A fresh answer cannot be spliced onto a half-sent
  one without garbling it, so the client now gets a truthful error and no second
  route is billed. Falling back before anything is sent still happens, which is
  the case fallback exists for.

- `git_worktree` no longer leaves a worktree registered in your repository when
  an attempt failed without changing anything. Retention deliberately never
  removes worktrees — unregistering one needs git, and only the owning repo can
  do it — so they accumulated per attempt, and a failed FALLBACK arm is not
  named in the response at all, so its worktree had no cleanup hint anywhere.
  Measured: one HTTP request leaving two entries in `git worktree list`. A
  failure that DID change files is still kept, because it may hold work worth
  recovering.

- `connect --yes` no longer overwrites a hand-edited client entry. The consent
  gate added for `--clients` treated "no client named" as consent, and `--yes`
  takes that path — so the flag that skips the question was accepted as an
  answer to it. Consent is answering the prompt, or `--force`.

- Streaming returns the ANSWER, not the harness's protocol. `POST
  /v1/chat/completions` with `stream: true` forwarded every stdout chunk into
  `delta.content`, so a client concatenating deltas from a CLI harness received
  `{"type":"thread.started",...}` and internal thread ids — while the
  non-streaming call on the same endpoint returned the parsed result. One
  endpoint, two answers, and the streaming one was unusable by the clients the
  OpenAI envelope exists for. An endpoint route still streams its text as it
  arrives; a CLI harness sends its answer once, at completion.

  Streaming still creates no job record, so there is no `jobId` and an
  interrupted stream cannot be recovered. Now stated in the README and
  OPERATIONS rather than left to be discovered.

- The HTTP surface refuses a bare `safety` key instead of dropping it. This
  product's own CLI flag is `--safety`, so it is the most plausible slip anyone
  will make — and at seven edits from `safetyProfile` the near-miss rule
  correctly declines to guess, which left it accepted and silently ignored while
  the dispatch ran at the default profile.

- `models: []` is refused instead of fanning out to every route. An explicit
  empty array fell through to the same branch as omitting the field, so a
  caller whose filter matched nothing got one dispatch per configured route —
  eight arms where an acceptance pass measured it. Omitting `models` is still
  how you ask for that, and it stays a deliberate keystroke.

- Job retention no longer deletes directories this tool never created. The
  sweep removed every stale directory under the jobs root recursively, with no
  check of any kind — the same defect workspace reclamation shipped twice in
  this release, found by an acceptance pass in the one place nobody had looked.
  Pointed at a directory holding `backup-20260401` and `my-notes`, it destroyed
  both. Only `job-<timestamp>-<8 hex>` directories are eligible now. Narrower
  in practice than the workspace case — neither `HARNESS_DISPATCH_JOBS_DIR` nor
  `HARNESS_DISPATCH_STATE_DIR` is documented in the README, unlike the
  workspaces override — but "narrower" is not a property anyone can rely on.

- `workingDir` must be an absolute path. A relative one was resolved against
  the SERVER's working directory rather than the caller's — and `../..` exists,
  so every check passed and a real dispatch ran somewhere neither party chose.
  The omitted-value warning could not fire either, since the value was not
  omitted. The caller and the server are different processes with different
  working directories, so there is no correct relative value to accept.

- The HTTP surface rejects a top-level key that is nearly a hint name, instead
  of accepting and dropping it. The outer body cannot be strict — it carries
  OpenAI's own fields — so `safteyProfile` (a transposition) and hints wrapped
  in `harness_dispatch` (the key this endpoint uses in its own *responses*, so
  the natural wrong guess) both returned HTTP 200 and dispatched at the default
  `workspace_edit`: more access than the caller asked for, with no signal,
  while the correct spelling produced `read_only`. Now refused by name with the
  intended spelling. One typo apart, transpositions included; unrelated keys
  and every OpenAI field stay legitimate.

- A CLI route asked for a safety profile its protocol has no flags for is now
  refused instead of run unconstrained. `{{safety}}` expands to the protocol's
  arguments for the requested profile and to nothing when the profile is
  missing, so a user-added route defining `workspace_edit` and `full_auto` but
  not `read_only` launched the harness with NO safety arguments — and every
  surface said `read_only`, including the dispatch log. An acceptance pass
  measured the child's argv: just the prompt. A route that cannot show it
  constrains anything is now treated as constraining nothing, which makes the
  existing compatibility check refuse it. The shipped harnesses are unaffected;
  they define all three profiles or pin the gaps with `effective_safety`.

- `status --json` and the `harness-dispatch://status.json` MCP resource no
  longer emit a route's `base_url` verbatim. Credentials embedded in the URL —
  `?key=…`, which is Google AI Studio's own shape — reached both, and that
  resource is one this server's instructions tell agents to read, so the
  credential landed in an agent's context. The text rendering was always
  redacted, which is how it hid. `redactEndpointHost` is also idempotent now:
  applying it twice used to be worse than once, degrading the model-discovery
  hint to a bare placeholder.

- `overrides:` gets the same value and unknown-key checks as the route blocks.
  It was left out when they were added, and it is the block most likely to carry
  the fields they exist for — the shipped config presents `overrides:` as the
  way to adjust `tier` and `weight` without writing a full config.

- A recognised config key carrying the wrong TYPE of value now says so instead
  of silently taking the default. The unknown-key warning covered a misspelled
  key; it never covered a correctly-spelled one whose value cannot be read,
  because the key is not unknown — `coercions.ts` drops on mismatch and the
  caller supplies a default. Found live on the maintainer's own machine by an
  acceptance pass: four routes carrying `tier: metered`, which is not a number,
  silently running at the default tier 3, with nothing ever having said so.
  `weight: very-high` becomes 1.0 the same way, and both feed routing.

- A route name declared twice now warns that everything the earlier entry set is
  discarded. Measured: a first entry setting `safety_profile: read_only` and
  `workspace_policy: copy`, replaced wholesale by a second with neither, left
  the surviving route running `workspace_edit` / `shared_locked` — silently
  LESS restrictive than what was written, with no warning on any surface.

- `services:` written as a YAML list no longer fails silently. It must be a map
  of route id to settings, but `typeof [] === "object"`, so a list slipped
  through and became routes called `0`, `1`, … with each item's `name:`
  ignored. Nothing looked wrong — `doctor` reported the routes and `status`
  listed them — until `--service my_route` answered "Unknown service". The
  mistake is a natural one: the sibling keys `clis:` and `endpoints:` ARE lists
  whose items carry `name:`. The behaviour is unchanged; it now says what
  happened, what the ids became, which names were dropped, and how to write it.

- `connect` keeps the last three backups of a client config rather than one per
  run forever. Every write and every removal takes one, and `~/.claude.json`
  holds live API keys, so the old behaviour accumulated copies of someone's
  secrets with nothing to prune them. They are bounded rather than deleted by
  `--remove`: undoing a registration is the worst moment to destroy the record
  of what it replaced. Backups anyone else made are not touched.

- Retrying a job on a DIFFERENT route no longer carries the old route's model,
  which defeated the one thing retargeting exists for. A model name belongs to
  the route it was picked for, so reusing it verbatim made the retry fail for
  the same reason as the original: observed end to end, a Cursor run that died
  on `Cannot use this model` was retried onto Claude and died on
  `unrecognized_model`, never reaching the task. That same job now completes.

  Narrow, and reported rather than silent. The model is kept when the retry
  stays on the original route (a plain "try that again") and when the new route
  declares it anyway; only a model the destination does not know is left
  behind, and the response says so as `droppedModel`.

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

[Unreleased]: https://github.com/fstubner/harness-dispatch/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/fstubner/harness-dispatch/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/fstubner/harness-dispatch/compare/v0.7.9...v0.8.0
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
