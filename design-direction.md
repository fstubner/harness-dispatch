# Design direction

## Scope, stated first

This project has no application UI. Its interfaces are:

1. **Terminal output** — `status`, `doctor`, `usage`, and the live dashboard
   (`src/dashboard/live.ts`, a pure `state -> ANSI string` renderer).
2. **A documentation site** — `site/`, Astro, published to GitHub Pages.

The primary consumer of the *product* is an agent reading JSON over MCP. Every
human-facing surface here is secondary: something you look at when you want to
know whether routing is behaving, or when you are deciding whether to install
it at all. This document exists to keep those surfaces coherent, not to
describe a design system this project does not have and does not need.

## Interview

No interview was held, and inventing one would be worse than saying so. This
direction was derived from two sources:

1. **The existing surfaces**, read as evidence — what `status`, `doctor` and
   `usage` already print, and the constraints of a pure `state -> string`
   renderer.
2. **Corrections from the maintainer during the 2026-08-17/18 session**, which
   changed the product read materially: the job is farming work out to other
   models, with cost safety as a guardrail rather than the point. Terminal
   surfaces are diagnostic, not the product.

What was NOT established, and should be if this ever grows a real UI: who reads
the documentation site and what they are deciding when they arrive. The
direction below is deliberately conservative because of that gap.

## Principle

**Legible under stress.** These surfaces are read when something is wrong —
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

**Colour is decoration, never meaning.** This applies to the TERMINAL
surfaces. Output is piped, redirected to logs, Anything colour conveys must also be conveyed by the text —
`ok` / `off`, `open` / `closed`. This also settles the accessibility question:
there is nothing to fail a contrast check on if colour is never load-bearing.

**Alignment over ornament.** Fixed-width labels and consistent key=value
ordering, so a reader's eye lands in the same place on every route block. No
box drawing, no tables in `status` output — they break at narrow widths and in
log capture.

**Density by section, not by line.** One route is a short block: identity,
billing, safety, quota, counts, capacity. Related facts stay adjacent so a
route can be judged without scrolling back.

**Silence is a state.** A clean install prints few lines. Absence of warnings
is the success signal; there is no "all good" banner to scan past.

## Documentation site

**Lead with what it does.** The README and site both open on the job — farming
work out to other models — not on caveats or configuration. Caveats follow;
they do not greet.

**Prose over diagrams.** The system's interesting parts are policies and
guarantees, which diagrams flatter and obscure. Tables where things are
genuinely parallel (safety profiles, workspace policies, route states),
otherwise sentences.

**Show real output.** Examples are copied from actual runs, not idealised.
A user comparing their terminal against the docs should see the same shape.

## Tone

Plain, specific, unhedged. This is a tool that spends the user's money and runs
agents with file access on their machine; the writing should read like it takes
that seriously. State limits directly — "Cursor cannot serve `workspace_edit`
on Windows" — rather than burying them in qualifiers.

## Explicit non-goals

- No colour theme for the *terminal* surfaces: the terminal's theme is the
  user's. The documentation site does have tokens (`design-tokens.json`, two
  themes: the light page and the dark code panel), because it is a styled
  public page and its contrast has to be checkable by something other than a
  person squinting at it.
- No branding, logo, or visual identity work.
- No interactive dashboard beyond the existing watch mode.
- No dark/light variants of the site. The two token themes are surfaces that
  coexist on one page, not a user-selectable mode.
