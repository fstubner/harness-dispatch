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
