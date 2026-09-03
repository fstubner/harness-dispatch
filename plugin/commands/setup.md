---
name: setup
description: Interactive setup — detect providers, configure enable/disable and API keys, write ~/.harness-dispatch/config.yaml
---

Set up harness-dispatch configuration for this user. $ARGUMENTS

**Prefer the tool's own setup flow.** `harness-dispatch configure --yes` detects
the installed harnesses, writes `~/.harness-dispatch/config.yaml` for them, and
offers to register the server with Claude Code and Cursor. Run that first and use
this command to ADD what it cannot detect (HTTP endpoints, per-route preferences)
or to explain what it wrote. Re-running `configure --yes` later regenerates a file
it wrote and nobody has edited, so installing a harness afterwards needs no flags.

**The rule that governs every edit below.** A config that contains a `clis:` or
`endpoints:` key is AUTHORITATIVE about routes: auto-detection is switched off and
the file's own list is the whole route table. So adding an `endpoints:` block to a
file that relied on detection silently removes every CLI harness — `disabled:` and
`overrides:` then apply to nothing, because they tune detection. Whenever this
command writes `endpoints:` (or `clis:`), it MUST either add `detect: true` to
keep the detected harnesses in the mix, or list every CLI route explicitly under
`clis:`. Never write `endpoints:` alongside `disabled:`/`overrides:` and stop
there. Verify with `harness-dispatch doctor`, which reports both the ignored-key
warning and any harness installed but missing from the config.

1. **Detect current state.** Check which provider CLIs are installed
   (`claude`, `codex`, `cursor-agent`, `agy` — use `where`/`which`). Check
   whether `~/.harness-dispatch/config.yaml` already exists; if so, read it and
   treat this as an edit session, preserving anything the user doesn't change.
   Note whether it already defines routes (`clis:`/`endpoints:`) or sets
   `detect:`, since that decides which shape step 3 must write.

2. **Interview the user** (use structured questions where available):
   - Which detected CLI providers to enable/disable, and whether any should
     be deprioritized (tier 2) rather than disabled.
   - Whether to add OpenAI-compatible endpoint providers (Groq, Google AI
     Studio / Gemini API, a local llama.cpp/Ollama server, other). For each:
     base URL, default model, and the env var name for its API key (local
     endpoints usually need no key).
   - Which route should be preferred for everyday delegation, if they have
     an opinion (implement via `overrides` tiers/weights).

3. **Write `~/.harness-dispatch/config.yaml`,** in ONE of these two shapes —
   mixing them is the failure described above:

   - **Detection plus endpoints** (the usual choice): `detect: true`, then
     `endpoints:` for the HTTP providers, and `disabled:`/`overrides:` to tune
     the detected CLI routes. The `detect: true` line is what keeps `disabled:`
     and `overrides:` meaningful once `endpoints:` is present.
   - **Fully explicit**: `clis:` listing every harness route to run, plus
     `endpoints:`. Detection stays off; `disabled:`/`overrides:` do nothing here,
     so drop them and edit the entries directly.

   API keys MUST be written as `${ENV_VAR}` references — never literal
   secrets. Keep the file commented so it's self-explanatory.

4. **Report what's needed from the user.** List the exact env vars they must
   set (e.g. `setx GROQ_API_KEY ...` on Windows, shell profile export
   elsewhere), where to get each key, and that the host app (Claude Code /
   Claude Desktop / Codex) must be restarted to pick up env and MCP changes.

5. **Verify.** Run `harness-dispatch doctor` and read two lines in particular:
   `config-warnings` (a key that had no effect — the authoritative-config
   mistake shows up here) and `routes` (which names any harness installed on
   the machine but absent from the config). Then, after restart (or immediately
   if the server is already running), call the `usage` tool and confirm the
   expected routes show `ready: true`; routes with missing keys will show
   ready: false — point those out rather than treating them as errors.
