# Configuration

Everything `config.yaml` can express: adding a harness, endpoint modes, and
what `configure` writes. The file is optional — harness-dispatch auto-detects
installed CLIs and runs without one.

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

**`detect: true` is doing real work there.** A config that lists any `clis:` or
`endpoints:` is authoritative: it gets exactly the routes it names, and nothing is
auto-detected alongside them. Without that line, the snippet above does not *add*
`codex_sol` and `ollama` to your installed harnesses — it replaces them, and
`claude_code_cli`, `codex_cli`, `cursor_cli` and `antigravity_cli` are gone.

Which one you want depends on the goal:

| You want | Write |
|---|---|
| My routes *plus* whatever is installed | `detect: true` alongside your entries |
| Exactly the routes I list, nothing else | just the entries (the default) |
| Nothing but auto-detection, minus a route | no `clis:`/`endpoints:`, plus `disabled: [name]` |
| No routes at all | `detect: false` |

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
    timeout_ms: 900000  # optional; overrides the 60-minute job default (10 min applies only to the CLI `dispatch` command and `doctor --live`)
    capabilities:
      execute: 0.8
      plan: 0.7
      review: 0.7
```

The older top-level `services:` format still loads, but it is a separate format:
a file that uses it has its `clis:`/`endpoints:` ignored with a warning, so do not
mix the two.
