---
name: setup
description: Interactive setup — detect providers, configure enable/disable and API keys, write ~/.harness-dispatch/config.yaml
---

Set up harness-dispatch configuration for this user. $ARGUMENTS

1. **Detect current state.** Check which provider CLIs are installed
   (`claude`, `codex`, `cursor-agent`, `agy` — use `where`/`which`). Check
   whether `~/.harness-dispatch/config.yaml` already exists; if so, read it and
   treat this as an edit session, preserving anything the user doesn't change.

2. **Interview the user** (use structured questions where available):
   - Which detected CLI providers to enable/disable, and whether any should
     be deprioritized (tier 2) rather than disabled.
   - Whether to add OpenAI-compatible endpoint providers (Groq, Google AI
     Studio / Gemini API, a local llama.cpp/Ollama server, other). For each:
     base URL, default model, and the env var name for its API key (local
     endpoints usually need no key).
   - Which route should be preferred for everyday delegation, if they have
     an opinion (implement via `overrides` tiers/weights).

3. **Write `~/.harness-dispatch/config.yaml`.** Use `disabled: [...]`,
   `overrides:` (model/tier/weight per service), and `endpoints:` entries.
   API keys MUST be written as `${ENV_VAR}` references — never literal
   secrets. Keep the file commented so it's self-explanatory.

4. **Report what's needed from the user.** List the exact env vars they must
   set (e.g. `setx GROQ_API_KEY ...` on Windows, shell profile export
   elsewhere), where to get each key, and that the host app (Claude Code /
   Claude Desktop / Codex) must be restarted to pick up env and MCP changes.

5. **Verify.** After restart (or immediately if the server is already
   running), call the `usage` tool and confirm the expected routes show
   `ready: true`; routes with missing keys will show ready: false — point
   those out rather than treating them as errors.
