# Configuration

Everything `config.yaml` can express: adding a harness, endpoint modes, what
`configure` writes, and a [reference for every key](#config-reference). The file is
optional — harness-dispatch auto-detects installed CLIs and runs without one.

## Adding a harness

`config.yaml` is entirely optional. There is no separate hidden defaults format —
harness-dispatch ships with its own [`config.default.yaml`](../config.default.yaml), the
same shape you'd write yourself, and reads it as its built-in config. With no
`config.yaml` of your own, the shipped one is filtered down to whichever of `claude`,
`codex`, `agy` (Antigravity; found but left off until you opt in, see
[vendor terms](#vendor-terms)), and `cursor-agent` are on your PATH:

```yaml
# config.yaml can be empty, or not exist at all.
```

Adding a harness that isn't auto-detected — a second Codex route pinned to a specific
model, or a local/hosted OpenAI-compatible endpoint — is a few lines:

```yaml
detect: true            # keep auto-detected harnesses as well; see below

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

### Listing a route turns detection off

This is the one rule every other page links to. A config that lists any `clis:` or
`endpoints:` is **authoritative**: it gets exactly the routes it names, and nothing
is auto-detected alongside them. So `detect: true` is doing real work in the snippet
above. Without that line it does not *add* `codex_sol` and `ollama` to your installed
harnesses — it replaces them, and `claude_code_cli`, `codex_cli`, `cursor_cli` and
`antigravity_cli` are gone. The same rule means `disabled:` and `overrides:` (which
tune auto-detected routes) do nothing in a file that lists routes and omits
`detect: true`; `doctor` and `status` warn when that happens.

Which one you want depends on the goal:

| You want | Write |
|---|---|
| My routes *plus* whatever is installed | `detect: true` alongside your entries |
| Exactly the routes I list, nothing else | just the entries (the default) |
| Nothing but auto-detection, minus a route | no `clis:`/`endpoints:`, plus `disabled: [name]` |
| No routes at all | `detect: false` |

Every key is listed in the [config reference](#config-reference) below. The shipped
[`config.default.yaml`](../config.default.yaml) is worked examples of the four built-in
harnesses, not a template: do not copy it (most of it is rationale). Start from
the short file `harness-dispatch configure --print` shows and add entries to it.

**A wholly new CLI harness (one of the 4 built in isn't it) needs no new code
either.** `harness: generic` takes a `protocol:` block instead of reusing one of the
4 built-in harnesses' flag/output conventions. `protocol.args` is a literal
command-line argument list, written the same way you'd type it by hand. A handful of
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
| `{{safety}}` | `safety[profile]` for the effective profile — the requested one, or the floor `effective_safety` sets — zero or more tokens |
| `{{working_dir}}` | `[working_dir.flag, dir, ...working_dir.extra_args_when_set]` if set, else nothing |
| `{{file_dirs}}` | `[file_dirs.flag, dir]` repeated once per included file's directory |
| `{{native_args}}` | `endpoint_native_args[endpoint_provider]`, only under `endpoint_mode: harness_native_endpoint` |

**Protocols are named and selectable, not just inline.** `claude_code`, `codex`,
`cursor`, and `antigravity_cli` are registered presets — every entry's `harness:` value
in the shipped [`config.default.yaml`](../config.default.yaml)'s `clis:` list is
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
either: there is no per-harness dispatcher class or hardcoded TypeScript data for any
of them in this codebase. All 4 are ordinary `clis:` entries in the shipped
[`config.default.yaml`](../config.default.yaml), not a separate "defaults registry" in
some other format, loaded through the exact same parser as your own `config.yaml`,
covering each CLI's real flags including Codex's mid-run tool_use/thinking/usage
streaming events via `event_rules` (see below). Every CLI-type route, built-in or
user-added, runs through the one `GenericCliDispatcher` interpreter. Copy an entry
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
Code/Codex use (exit 0 alone, falling back to raw stdout/stderr text when
parsing yields nothing). Billing for a `generic` route defaults to `unknown` (blocked
until you classify it — there's no way to know an arbitrary CLI's real billing model) —
set `billing_kind:` / `paid_usage_possible:` explicitly once you know it.

### Safety profiles on the shipped Codex route

Codex's `full_auto` runs with `--sandbox workspace-write`, the same as
`workspace_edit`. That is deliberate: the unsandboxed reading of "full auto" is
`danger-full-access`, and the shipped default keeps shell inside Codex's own
sandbox. If you really want the unsandboxed behaviour for that route, say so in
your own config:

```yaml
overrides:
  codex_cli:
    protocol:
      extends: codex
      safety:
        full_auto: ["--sandbox", "danger-full-access"]   # only this profile changes
```

`safety` merges per profile, so `read_only` and `workspace_edit` keep their
shipped sandboxes.

## Configure

`configure` is the main setup flow. It does four things, in order, and prompts for
nothing except the final registration:

1. Detect installed harness CLIs on PATH (or load the existing config, when there
   is one it did not write itself — see the note on re-runs under Install).
2. Print every route with its billing classification and effective safety
   profile, and say which routes are blocked until you opt in to paid usage.
3. Write the config YAML (`--yes`; without it, nothing is written).
4. Offer to register with each MCP client it finds, or print the snippet
   (`--no-clients`).

There is no interactive choice of harnesses, model priority or safety profile:
edit the written file for those.

The current command is conservative: it prints detected routes by default and writes
only when explicitly asked with `--yes`.

Writing the config is also what turns detection off: the detected harnesses become
`clis:` entries, and a config that lists routes is authoritative, so the PATH lookup
no longer runs at every start. With no config file, detection runs every time (it is
fast, but not free); `configure --yes` once removes that.

## Instructions for connecting agents

Routing policy for this machine — which `hints.modelTier` for which kind of task,
which route to prefer — can live in `config.yaml` instead of in every client's own
instruction file (CLAUDE.md, AGENTS.md and the like):

```yaml
instructions: |              # told to every agent that connects
  Prefer Codex for refactors; modelTier strong only for hard judgment.

overrides:                   # an auto-detected route
  claude_code_cli:
    instructions: "best for plan and review; slow to start, so expect a jobId"
endpoints:
  - name: local_box
    base_url: http://127.0.0.1:1234/v1
    instructions: "one model loaded; leave hints.model unset"
```

- The server sends its own instructions to every agent when it connects, and
  appends these: the top-level block, then each enabled route's, listed by route
  id. A route's text is also returned for that route by the `usage` tool.
- `instructions:` works on `clis:`, `endpoints:`, `overrides:` and legacy
  `services:` entries.
- Each value is capped at 1,000 characters; longer text is cut, with a warning.
  Every connected session carries this text in its context.
- It is read when a session connects: an edit reaches sessions that connect
  afterwards, not ones already open.
- A secret the config holds (an API key, say) is scrubbed from this text.

## API keys

A route's key can be written three ways. Prefer the first:

```yaml
endpoints:
  - name: groq
    base_url: https://api.groq.com/openai/v1
    model: openai/gpt-oss-120b
    api_key_file: ~/.harness-dispatch/keys/groq   # read once at load
    # api_key: ${GROQ_API_KEY}                     # or from the environment
```

- `api_key_file:` reads the key from a file when the config loads. A relative
  path is relative to the config file, and `~/` is your home directory. The key
  never enters any process environment, so no other delegate can inherit it;
  the route's own harness still receives it, as with `api_key:`. Keep the file
  readable only by you (`chmod 600` on macOS and Linux). A missing or empty file
  is an error naming the route. `configure` writes `api_key_file:` back, never
  the key.
- `api_key: ${VAR}` reads an environment variable. That variable is inherited
  by every process you start, and an MCP client's `env` block that sets it is
  plaintext JSON in your home directory, readable by any delegate that can read
  files there. harness-dispatch blanks it in the agents it starts, but it cannot
  hide the client config file.
- A literal `api_key:` works and is not recommended.

## Safety profiles and Cursor

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
- `workspace_edit` is **skipped, on every platform**. Cursor's print mode grants
  write and shell together. `--sandbox enabled`, the flag that would constrain
  shell while allowing edits, exists only on macOS and Linux, so the shipped
  route does not use it anywhere. There is no edit-without-shell mode to route
  to, and claiming that level would mean handing shell access to a caller who
  explicitly asked not to have it.

Cursor still edits code. Ask for `full_auto`.

### Overriding the Cursor floor

If you accept that Cursor's editing mode carries shell access and you want it
to serve `workspace_edit` anyway, declare the floor yourself in `config.yaml`.
Your value replaces the shipped default:

```yaml
overrides:
  cursor_cli:
    effective_safety:
      read_only: read_only
      workspace_edit: workspace_edit   # you are accepting shell access here
      full_auto: full_auto
```

Use `overrides:`, not a `clis:` entry: a config that lists any `clis:` entry is
authoritative and drops every harness it does not name, so a lone `cursor_cli` entry
would remove Claude Code, Codex and Antigravity from your routes. See
[listing a route turns detection off](#listing-a-route-turns-detection-off).

That is a deliberate local decision, not a bug workaround: the shipped default
is conservative because the tool cannot verify what a given `cursor-agent`
build will do. On macOS and Linux the better route is `--sandbox enabled`,
which constrains shell for real. It is untested here, so it is not shipped on by
default.

`antigravity_cli` declares the same floor, for the same reason: in headless
mode every profile has to auto-approve tool requests, and its edit mode does
that with nothing restricting the terminal. It serves `read_only` (`--mode plan
--sandbox`) and `full_auto`, and the same override applies.

Each profile is enforced by the harness itself, and the strength differs: Codex
runs inside an OS sandbox, Claude Code and Cursor apply their own in-process
permission rules, and Antigravity's `full_auto` approves everything. A Claude
Code delegate at `read_only` or `workspace_edit` gets only the file tools
(`--tools`) and no MCP servers (`--strict-mcp-config`); it still runs with your
Claude Code login, user settings, user-level hooks and `CLAUDE.md` files, but not
the project's own settings or hooks (`--setting-sources user`).

## Time limits

Two per-route limits, both optional, both in milliseconds:

```yaml
clis:
  - name: codex_cli
    harness: codex
    timeout_ms: 2700000       # wall clock per attempt
    idle_timeout_ms: 1200000  # stop after this long with no output at all
```

- `timeout_ms` caps one attempt. Unset, a background job gets what is left of
  its 60-minute budget (10 minutes for the CLI `dispatch` command and
  `doctor --live`). `hints.timeoutMs` on a dispatch overrides it.
- `idle_timeout_ms` (CLI routes only) stops a run that has printed nothing,
  on either stream, for that long, and reports it as hung. The wall clock
  alone cannot tell a hung run from a working one, and a hung run holds a
  concurrency slot until it fires. Set it only on a route whose harness
  prints as it works: one that prints only its final answer would be stopped
  partway through every long task.
- Shipped defaults: `codex_cli` and `antigravity_cli` get a 15-minute idle
  limit (both stream an event per step); `antigravity_cli` also gets a
  25-minute wall clock. `claude_code_cli` and `cursor_cli` print their answer
  only at the end, so they ship neither. A value in your own entry replaces
  the shipped one.

## Vendor terms

Each subscription route drives a vendor's own CLI as the logged-in user. The vendors'
terms differ on whether that is allowed; the sources, dates and short quotes are in
[PRODUCT.md, Risks](../PRODUCT.md#risks). What that means for the shipped routes:

- **`antigravity_cli` is opt-in.** Google's Antigravity terms object to third-party
  tools using the service, so auto-detection finds `agy` but adds the route switched
  off. `status` shows it as `skipped (disabled)` with the reason, and `doctor` repeats it. To turn it
  on, say so in your `config.yaml`:

  ```yaml
  overrides:
    antigravity_cli:
      enabled: true
  ```

  A `clis:` entry with `harness: antigravity_cli` is already that decision and is
  never switched off. `configure` writes a detected opt-in route as an entry with
  `enabled: false`; change that to `true` to opt in.
- **`cursor_cli` uses your interactive Cursor login, not an API key.** The shipped
  entry declares `auth_source: product_login` and sends no key. `CURSOR_API_KEY` is
  passed to the child only when the route has an `api_key:` of its own, which also
  reclassifies the route as metered. If the variable is set in the environment of the
  server and the route has no `api_key:`, it is blanked for the child, so an ambient
  key cannot move a login route onto metered billing. To use the key path Cursor's
  headless documentation shows, set `api_key: ${CURSOR_API_KEY}` on the route.
- **`claude_code_cli` and `codex_cli`** run the unmodified `claude` and `codex`
  binaries under your own login; harness-dispatch never reads their login tokens.

## Endpoint Modes

harness-dispatch supports two local/custom endpoint patterns:

- `direct_openai_compatible`: harness-dispatch calls an OpenAI-compatible
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

Example Codex harness-native local route, as a `clis:` entry (the same shape
`configure` writes; everything not set here comes from the shipped `codex` defaults):

```yaml
clis:
  - name: codex_ollama
    harness: codex
    model: qwen3-coder:latest
    endpoint_mode: harness_native_endpoint
    endpoint_provider: ollama
    wire_protocol: openai_chat_completions
    billing_kind: local_compute
    paid_usage_possible: false
    tier: 3
    weight: 0.75
    cli_capability: 1.0
    timeout_ms: 900000  # optional; see "Time limits" above
    capabilities:
      execute: 0.8
      plan: 0.7
      review: 0.7
```

The older top-level `services:` format still loads, but it is a separate format:
a file that uses it has its `clis:`/`endpoints:` ignored with a warning, so do not
mix the two.

## Config reference

Every key the parser recognises. Anything else is reported as a warning by `doctor`
and `status` and has no effect. `scripts/check-claims.mjs` fails if a recognised key
is missing from these tables.

### Top-level keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `detect` | boolean | `true` when the file lists no routes, `false` when it does | Add harness CLIs found on PATH. See [listing a route turns detection off](#listing-a-route-turns-detection-off). |
| `clis` | list of route entries | none | CLI harness routes: a built-in harness, or `harness: generic` with a `protocol:` block. Listing any makes the file authoritative. |
| `endpoints` | list of route entries | none | OpenAI-compatible HTTP routes. `name`, `base_url` and `model` are required, or the entry is ignored with a warning. Listing any makes the file authoritative. |
| `disabled` | list of route ids | none | Auto-detected routes to leave out. Applies only while detection runs, and never to your own `clis:`/`endpoints:` entries (use `enabled: false` on the entry). |
| `overrides` | map of route id to route keys | none | Change fields of an auto-detected route, for example `overrides: { codex_cli: { tier: 2 } }`. Applies only while detection runs. |
| `api_keys` | map of route id to key | none | A credential by route id. Write `${ENV_VAR}`, not the secret. For the four auto-detected ids, `<route_id>_api_key: ...` at the top level is shorthand. |
| `max_concurrent_runs` | integer >= 0 | `4` | Agent CLIs running at once, machine-wide; more queue. `0` lifts the cap. A value that is not a non-negative number is ignored with a warning. |
| `retention` | `{ jobs_days: N }` | `7` | Days a job's files are kept after it last changed. `0` keeps them forever. |
| `telemetry` | `{ enabled: true or false }` | `false` | OpenTelemetry tracing. See [Observability and privacy](operations.md#observability-and-privacy). |
| `leaderboard` | anything | none | **Removed.** Accepted so an old config keeps loading, reported as removed by `doctor` and `status`, and has no effect. Routing is tier, then weight x capability. |
| `instructions` | text, at most 1,000 characters | none | Policy told to every connecting agent. See [Instructions for connecting agents](#instructions-for-connecting-agents). |
| `services` | map of route id to route keys | none | The older route format. A file that uses it has `clis:`, `endpoints:` and `overrides:` ignored with a warning; do not mix them. |
| `version` | anything | none | Accepted and ignored. |
| `protocol` | anything | none | Accepted and ignored at the top level; a `protocol:` block belongs inside a route entry. |
| `protocols`, `policy`, `default_safety_profile`, `workspace_policy` | anything | none | Recognised but **not implemented**: setting one does nothing, and `doctor` says so. `safety_profile` and `workspace_policy` are real per-route keys, below. |

### Route keys

These work on `clis:` and `endpoints:` entries, on `overrides:` entries, and on legacy
`services:` entries. "Harness default" means the value the shipped
[`config.default.yaml`](../config.default.yaml) gives that harness.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | text | none (required) | The route id, as `usage` and `service` spell it. A name declared twice keeps only the last entry, with a warning. |
| `harness` | `claude_code`, `codex`, `cursor`, `antigravity_cli`, `generic` | none for a new entry | Which built-in protocol the route uses; `generic` needs a `protocol:` block. |
| `type` | `cli` or `openai_compatible` | `cli` | Legacy `services:` entries only. `clis:` entries are always CLI routes and `endpoints:` entries always HTTP. |
| `command` | text | the harness's binary (`claude`, `codex`, `cursor-agent`, `agy`) | The executable, resolved on PATH. |
| `enabled` | boolean | `true`; auto-detected `antigravity_cli` ships `false` | `false` keeps the entry but takes the route out of routing. Turn the opt-in Antigravity route on with `overrides: { antigravity_cli: { enabled: true } }`; see [vendor terms](#vendor-terms). |
| `model` | text | none (required for an endpoint) | The model passed to the harness or endpoint. Unset on a CLI route, the harness runs its own default. |
| `models` | list of text | harness default | Operator-curated model ids. `usage` lists them, and `listModels` returns them instead of querying the endpoint. |
| `model_hint` | text | harness default | Where this harness's real model catalog is documented; shown by `usage`. |
| `model_tiers` | map of `cheap`, `standard`, `strong` to a model id | harness default (`claude_code_cli`: `haiku`, `sonnet`, `opus`; `codex_cli`: `gpt-5.6-terra` for standard, `gpt-5.6-sol` for strong), but only on an entry with no `model:` of its own | The model this route runs for a dispatch's `hints.modelTier`. A tier with no entry runs the route's default model, reported as `routing.modelTierMatched: false`. A declared map replaces the harness default rather than merging with it. `hints.model` wins over it. Shown by `usage`. |
| `instructions` | text, at most 1,000 characters | none | Policy for agents using this route; shown by `usage` and in the server instructions. |
| `tier` | integer | harness default; `3` for an endpoint | Lower tiers are tried first; routes in a tier are ranked by score. |
| `weight` | number | `1.0`; `0.6` for an endpoint | Multiplier in the route's score. |
| `cli_capability` | number | harness default; `1.0` for an endpoint | Multiplier for how capable the harness's own agent loop is. |
| `capabilities` | `{ execute, plan, review }`, numbers | harness default; `1.0` each for an endpoint | Per-task fit, multiplied into the score. |
| `escalate_model` | text | none | Model to use instead of `model` when the dispatch's `hints.taskType` is in `escalate_on`. |
| `escalate_on` | list of `execute`, `plan`, `review`, `local` | `[plan, review]` | Task types that get `escalate_model`. Does nothing without it. |
| `timeout_ms` | integer, milliseconds | none (60 minutes on MCP and HTTP dispatches); `antigravity_cli` ships 25 minutes | Hard ceiling for a run on this route. `hints.timeoutMs` wins over it. See [Time limits](#time-limits). |
| `idle_timeout_ms` | integer, milliseconds | none; `codex_cli` and `antigravity_cli` ship 15 minutes | CLI routes only: stop a run that has printed nothing on either stream for this long, and report it as hung. Accepted and ignored on an `endpoints:` entry. See [Time limits](#time-limits). |
| `resource_weight` | number >= 0 | `1.0` for a CLI route, `0.1` for an endpoint | What one run of this route counts for against `max_concurrent_runs`. |
| `max_input_tokens`, `max_output_tokens` | integer | harness default | Context and output limits. The input limit feeds `preferLargeContext`; the output limit is the `max_tokens` an endpoint is sent. |
| `thinking_level` | `low`, `medium`, `high` | harness default | Sent to an endpoint route as `reasoning_effort`. A CLI route does not read it. |
| `leaderboard_model` | text | none | **Removed.** Accepted and reported as removed; it has no effect. Delete the line. |
| `api_key` | text | none | A credential for this route; write `${ENV_VAR}`. A key on a CLI route marks it metered. |
| `api_key_file` | path | none | Read the key from this file when the config loads, instead of writing it or an env var here. Relative to the config file; `~/` is your home directory. Setting it together with `api_key`, or pointing it at an unreadable or empty file, is an error naming the route. See [API keys](#api-keys). |
| `base_url` | URL | none (required for an endpoint) | The endpoint's API root. |
| `protocol` | preset name, or a block | harness default | How to call a CLI. See [Adding a harness](#adding-a-harness). |
| `filter` | anything | none | Accepted and ignored. |
| `provider`, `surface`, `auth_source` | text, from the lists in `status` | harness default; inferred from `base_url` for an endpoint | Billing identity, as `status` reports it. |
| `billing_kind` | `local_compute`, `included_plan_usage`, `included_plan_then_flexible_credits`, `included_credit_then_optional_overage`, `included_usage_then_on_demand`, `metered_api`, `free_quota`, `unknown` | harness default; `metered_api` with an `api_key` | What this route bills against. An unknown value is warned about, not guessed. |
| `billing_confidence` | `documented`, `inferred`, `unknown`, `unsupported` | harness default | How sure the classification is. |
| `billing_notes` | text | none | Shown as the route's `note:` in `status`. |
| `paid_usage_possible` | boolean | harness default; `true` with an `api_key` | Whether a call can cost money. |
| `allow_paid_usage` | boolean | `false` | Opt in to a route that can cost money or whose billing is unknown. Without it such a route is skipped. |
| `safety_profile` | `read_only`, `workspace_edit`, `full_auto` | `workspace_edit` | The profile requested for this route when the caller names none. |
| `effective_safety` | one profile, or a map of requested profile to floor | harness default | What the route really runs at. A route is skipped when its floor exceeds what was requested. |
| `workspace_policy` | `shared`, `shared_locked`, `copy`, `git_worktree` | `shared` for `read_only`, else `shared_locked` | Where the run happens. A caller's `workspacePolicy` wins over it. See [Operating it](operations.md#status-model). |
| `endpoint_mode` | `direct_openai_compatible`, `harness_native_endpoint` | `direct_openai_compatible` for an endpoint | See [Endpoint modes](#endpoint-modes). |
| `endpoint_provider` | text, such as `ollama` or `lmstudio` | inferred from `base_url` | Which local provider a harness-native endpoint points at. |
| `wire_protocol` | `openai_chat_completions` | `openai_chat_completions` with an endpoint mode | The wire format. |
