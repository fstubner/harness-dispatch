# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue. Use GitHub's private
vulnerability reporting:

<https://github.com/fstubner/harness-dispatch/security/advisories/new>

Include the version (`harness-dispatch --version`), your operating system, and the
steps or a small config that reproduce it. If the report involves a prompt or a
config that makes a delegate do something it should not, include that exactly.

The maintainer replies on the advisory and credits you in the fix unless you ask
otherwise.

## What is in scope

harness-dispatch starts coding agents with file access on your machine, so the
parts that decide what they can touch matter most:

- **Credential handling.** The HTTP bearer token (`auth show`, `auth rotate`, the
  token file and its permissions), API keys in config and how they reach a child
  process, and any path by which a key or login token is printed, logged, written
  to a job directory, or passed to a route it does not belong to.
- **Delegate isolation.** The safety profiles (`read_only`, `workspace_edit`,
  `full_auto`) and the workspace policies (`shared_locked`, `copy`,
  `git_worktree`): a delegate that gets more access than the profile asked for,
  or an isolated run that reaches the original project before `workspace apply`.
- **`workspace apply` and `discard`, and the cleanup sweeps.** Anything that writes,
  overwrites or deletes files outside the run's own workspace, including path
  traversal through a patch, a symlink, or a `jobId`.
- **The HTTP API.** `serve`, `/mcp` and `/v1/*`: authentication bypass, a server
  that listens beyond loopback without `--host`, or input that is not validated at
  the boundary.
- **`connect` and `configure`.** Writes into other applications' config files
  (Claude Code, Cursor).

## What is not in scope

- A delegate with shell access (`full_auto`, or a route whose harness grants shell)
  can reach anything your user account can. The workspace policies isolate project
  state, not the host. This is documented in the
  [README](README.md#safety-profiles-and-cursor) and is not a vulnerability.
- Bugs in the harness CLIs themselves (Claude Code, Codex, Cursor Agent,
  Antigravity). Report those to their vendors.
- A malicious `config.yaml` you chose to load. The config decides what commands run,
  which is why a `config.yaml` in the current directory is never picked up on its
  own.
- Spend on a provider account that already has paid or overage billing switched on.
  harness-dispatch cannot see or change that.

## Supported versions

Only the latest minor version (currently 0.12.x) receives security fixes. The project
is pre-1.0 and there are no backports; update to the latest release.
