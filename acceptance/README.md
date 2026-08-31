# Acceptance records

One file per published version, `acceptance/<version>.md`, written **after** an
independent acceptance pass has run against that build and **before** the tag
is pushed. `scripts/check-acceptance.mjs` refuses to publish without one, and
the publish workflow runs it.

## Why the gate is on ordering, not on the verdict

Every regression this project has shipped was found by an acceptance pass:
0.7.0's wrong apply base, 0.7.2's dropped deletions, 0.7.3's path base, 0.7.6's
two miscalibrated guards, 0.7.7's under-counted escaping. None was missed. All
of them were already on npm when the pass ran, because publishing came first.

So the gate does not try to judge quality — it makes the sequence mechanical.
A `CONDITIONAL` verdict passes deliberately: most passes here are CONDITIONAL,
and shipping on one is a real decision with the open items written down. A
`BLOCK` fails. A version with no record at all fails, which is the case that
actually kept happening.

## Format

Fields are `- key: value` lines; anything after them is free text and is not
parsed.

```markdown
# Acceptance — 0.7.8

- version: 0.7.8
- verdict: CONDITIONAL
- date: 2026-08-23
- reviewer: independent agent pass, separate context from the build

## Open at ship time

- Rate-limit detection still scans the delegate's stdout (finding 4).

## Verified

- ...
```

`version` must match the version being published — a record copied from a
previous release proves nothing about this one, and the checker rejects it.

`reviewer` should say whether the pass was independent of the build. A pass run
by the same context that wrote the code is capped at CONDITIONAL by the
acceptance skill for good reason, and saying so here keeps that visible.

## Every pass makes ONE live dispatch

Through a real harness. Not a fake upstream, not a stub dispatcher.

Nine consecutive passes verified this product without once exercising the thing
it exists to do. Each recorded "no live provider calls" under what it did not
check, which reads like a limitation and was in fact an instruction — the
prompts said not to spend quota. Meanwhile the installed subscription CLIs work
fine: a live smoke run in the same period dispatched to Claude Code, Codex and
Antigravity end to end and all three came back ok.

Economising there was the wrong trade. The routes are flat-rate, so a short
delegation costs approximately nothing, and the alternative is a verdict about
a routing tool in which nothing was ever routed.

The shape, kept deliberately small so the cost stays near zero and nobody is
tempted to skip it:

- ONE *successful* dispatch. A route that refuses before running — rate
  limited, not logged in — costs nothing and does not count against this;
  try the next subscription route and say which ones refused. The first pass
  to follow this rule hit a rate-limited Codex and would otherwise have had to
  stop at "unavailable today" with a working harness sitting next to it.
- Not a fanout, not a sweep across routes.
- A subscription-backed CLI route — flat-rate, so the marginal cost is nil.
- `hints.safetyProfile: "read_only"` and a short prompt.
- NEVER a metered route, and never `--allow-paid`. A pass must not be able to
  spend money.
- `doctor --live` stays optional; it probes every eligible route and can burn a
  subscription window, which is the cost this rule is trying not to pay.

The one-liner, which runs the build in the working tree rather than whatever
MCP server happens to be connected:

```
node dist/bin.js dispatch --service <route> --safety read_only --no-fallback "Reply with exactly one word: pong"
```

`--service` goes through `routeTo`, so it runs exactly that route and cannot
fall onto another. That distinction matters here: the plain `route`/`dispatch`
path hardcoded `execute` with two fallbacks until 0.8.0, so a pass asking for
one read-only call could get an execute-profile run on up to three.

Record it under **Verified**, naming the route and what came back. If no
harness is installed or all of them are rate-limited, say that under what was
not checked — "unavailable today" is a different and honest claim from "did not
try".
