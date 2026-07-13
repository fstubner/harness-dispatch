# harness-router plugin

One plugin directory serving both ecosystems (the SKILL.md format is shared):

- **Claude Code / Claude Desktop** — installed as a Claude Code plugin
  (bundles the MCP server, the `delegating-work` skill, and `/route` +
  `/jobs` commands).
- **Codex CLI / Codex desktop** — installed by `scripts/install-codex.mjs`
  (registers the MCP server via `codex mcp add` and copies the same skill to
  `~/.codex/skills/harness-router/`).

## Install — Claude Code / Claude Desktop

From a clone of this repo (or the published git URL):

```
/plugin marketplace add H:/path/to/harness-router
/plugin install harness-router@harness-router
```

## Install — Codex CLI / Codex desktop

```bash
node plugin/scripts/install-codex.mjs
# pin a specific config instead of ~/.harness-router/config.yaml:
node plugin/scripts/install-codex.mjs --config H:/path/to/config.yaml
# preview without changing anything:
node plugin/scripts/install-codex.mjs --dry-run
```

Verify with `codex mcp list`.

## Configuration

Run the `/harness-router:setup` command (Claude Code) after installing — it
interviews you and writes `~/.harness-router/config.yaml`. Or write the file
by hand; see the main README for the schema. Secrets are never stored in the
plugin or config: `config.yaml` references `${ENV_VAR}` names and the values
come from the environment the host app runs in.

## What actually runs

`.mcp.json` starts `scripts/launch-mcp.mjs`, which picks the server binary in
this order:

1. `../../dist/bin.js` relative to the plugin — present when the plugin runs
   from inside a built working copy of this repo (developers).
2. `npx -y harness-router` — the published npm package.

Config resolution: `HARNESS_ROUTER_CONFIG` env var, else
`~/.harness-router/config.yaml`, else the server's built-in CLI auto-detection.

Endpoint API keys (`GROQ_API_KEY`, `GEMINI_API_KEY`, …) are read from the
inherited environment by `config.yaml`'s `${VAR}` interpolation. CLI-based
routes (Claude Code, Codex, Cursor, Antigravity) use product logins and need
no keys.
