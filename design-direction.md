# Design direction

## Scope, stated first

This project has no application UI. Its human-facing interface is **terminal
output**: `status`, `doctor` and `usage`. (`dashboard` and `list-services` survive
as aliases of `status`.) The README and `docs/` are prose, covered under Tone.

The primary consumer of the *product* is an agent reading JSON over MCP. Every
human-facing surface here is secondary: something you look at when you want to
know whether routing is behaving, or when you are deciding whether to install
it at all. This document exists to keep those surfaces coherent, not to
describe a design system this project does not have and does not need.

## Interview

No interview was held, and inventing one would be worse than saying so. This
direction was derived from two sources:

1. **The existing surfaces**, read as evidence: what `status`, `doctor` and
   `usage` already print, and the constraints of plain text output.
2. **Corrections from the maintainer during the 2026-08-17/18 session**, which
   changed the product read materially: the job is farming work out to other
   models, with cost safety as a guardrail rather than the point. Terminal
   surfaces are diagnostic, not the product.

## Principle

**Legible under stress.** These surfaces are read when something is wrong:
a route is not being picked, a dispatch failed, spend is unexpected. Optimise
for a person scanning for the one line that matters, not for browsing.

Consequences:

- The abnormal must be visible without reading everything. `skipped=`,
  `breaker=open`, `rate_limited=` appear only when they apply, so their
  presence is the signal.
- Numbers carry units or context (`quota=100%`, `context=1.0M`,
  `failed=0 rate_limited=20`). A bare integer is not information.
- Never soften. A skipped route says it is skipped and why, in the same line.

## Terminal surfaces

**Colour is decoration, never meaning.** Output is piped and redirected to
logs, so anything colour conveys must also be conveyed by the text:
`ok` / `off`, `open` / `closed`. This also settles the accessibility question:
there is nothing to fail a contrast check on if colour is never load-bearing.

**Alignment over ornament.** Fixed-width labels and consistent key=value
ordering, so a reader's eye lands in the same place on every route block. No
box drawing, no tables in `status` output: they break at narrow widths and in
log capture.

**Density by section, not by line.** One route is a short block: identity,
billing, safety, quota, counts, capacity. Related facts stay adjacent so a
route can be judged without scrolling back.

**Silence is a state.** A clean install prints few lines. Absence of warnings
is the success signal; there is no "all good" banner to scan past.

## Tone

Plain, specific, unhedged. This is a tool that spends the user's money and runs
agents with file access on their machine; the writing should read like it takes
that seriously. State limits directly ("Cursor cannot serve `workspace_edit`
on any platform") rather than burying them in qualifiers.

The README opens on the job, farming work out to other models, not on caveats or
configuration. Caveats follow; they do not greet. Prefer prose over diagrams: the
interesting parts are policies and guarantees, which diagrams flatter and obscure.
Use a table where things are genuinely parallel (safety profiles, workspace
policies, route states). Examples are copied from real runs, so a user comparing
their terminal against the docs sees the same shape.

## Explicit non-goals

- No colour theme for the terminal surfaces: the terminal's theme is the user's.
- No branding, logo, or visual identity work.
- No interactive dashboard beyond the existing watch mode.

`design-tokens.json` is a leftover from the documentation site, which was removed on
2026-10-04 and returns, if at all, as part of a shared site for several products. Nothing
in this repository reads it. It stays because the agent-skills frontend checker
(`check-frontend.js`, rule `F-tokens-contrast`) looks for it, and a missing file makes
that rule report `not_evaluated`. Delete it together with a decision to stop running
that checker.
