# harness-dispatch plugin

One plugin directory serving both ecosystems (the SKILL.md format is shared):

- **Claude Code / Claude Desktop** — installed as a Claude Code plugin
  (bundles the MCP server, the `delegating-work` skill, and the `/route`,
  `/jobs` and `/setup` commands).
- **Codex CLI / Codex desktop** — installed by `scripts/install-codex.mjs`
  (registers the MCP server via `codex mcp add` and copies the same skill to
  `~/.codex/skills/harness-dispatch/`).

## Install — Claude Code / Claude Desktop

From a clone of this repo (or the published git URL):

```
/plugin marketplace add H:/path/to/harness-dispatch
/plugin install harness-dispatch@harness-dispatch
```

## Install — Codex CLI / Codex desktop

```bash
node plugin/scripts/install-codex.mjs
# pin a specific config instead of ~/.harness-dispatch/config.yaml:
node plugin/scripts/install-codex.mjs --config H:/path/to/config.yaml
# preview without changing anything:
node plugin/scripts/install-codex.mjs --dry-run
```

Verify with `codex mcp list`.

## Configuration

Run the `/harness-dispatch:setup` command (Claude Code) after installing — it
interviews you and writes `~/.harness-dispatch/config.yaml`. Or write the file
by hand; the schema is the
[config reference](../docs/configuration.md#config-reference). Secrets are never stored in the
plugin or config: `config.yaml` references `${ENV_VAR}` names and the values
come from the environment the host app runs in.

## What actually runs

`.mcp.json` starts `scripts/launch-mcp.mjs`, which picks the server binary in
this order:

1. `../../dist/bin.js` relative to the plugin — present when the plugin runs
   from inside a built working copy of this repo (developers).
2. `npx -y harness-dispatch` — the published npm package.

> Fallback 2 resolves to whatever is currently on the npm registry under the
> `harness-dispatch` name, which can lag behind this repo's `main`. If a feature
> described in the main README isn't showing up, check `npm ls -g harness-dispatch`
> (or the `version` field in the installed package's `package.json`) to see which
> one actually launched.

Config resolution, in order: the `--config` flag, else the
`HARNESS_DISPATCH_CONFIG` env var, else `~/.harness-dispatch/config.yaml`, else
the server's built-in CLI auto-detection. A `config.yaml` in the directory the
server was launched from is not read: a cloned repository can carry one, and
the config decides which commands run and what every connecting agent is told.
Point `HARNESS_DISPATCH_CONFIG` at a project config to use one. The user file moves with
`HARNESS_DISPATCH_STATE_DIR` when that is set, and the launcher passes that variable
through. The launcher itself, though, looks for the user file at the default
`~/.harness-dispatch/config.yaml` whatever `HARNESS_DISPATCH_STATE_DIR` says, and
hands it over with `--config` when it exists, which wins over the state-directory
file. To use a config elsewhere, set `HARNESS_DISPATCH_CONFIG`.

Endpoint API keys are best kept in files the server reads at load time
(`api_key_file: ~/.harness-dispatch/keys/groq`), so they never enter any
process environment. `${VAR}` references (`api_key: ${GROQ_API_KEY}`) also
work, read from the inherited environment; do not put keys in an MCP client's
`env` block, which is plaintext JSON that any delegate able to read your home
directory can read. CLI-based routes (Claude Code, Codex, Cursor, Antigravity)
use product logins and need no keys.
