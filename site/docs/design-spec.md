# Landing page design — locked rules

Date: 2026-07-23. Approved by Felix after the v1–v20 mockup exploration in
`.superpowers/brainstorm/`. These rules are the contract; any future edit to
the site is checked against this file, not against taste-per-iteration.

## Direction (the five decisions)

1. **Archetype/personality**: enterprise/tools — dense, technical, terse.
   Credibility through specificity (real fields, real numbers), not marketing
   adjectives.
2. **Type pairing**: IBM Plex Sans (prose) + JetBrains Mono (everything
   tool/terminal/data). Same pairing as the existing site.
3. **Surface strategy**: warm off-white page (#fbfaf6), hairline borders
   (#dedcd0), near-black ink (#16160f). Tool-call blocks are flat with a
   2px left rule — no cards, no shadows.
4. **Accent placement**: rust (#b8410f) for tool names and primary CTAs only.
   Green (#3f7a53) solely for success glyphs/rows. Amber (#7f6446, the `--busy` token) solely for
   in-progress.
5. **Signature move**: the hero is an interactive agent transcript — a
   realistic chat with collapsed tool-call lines that expand to show the real
   request/result shapes.

## Hero content rules (the six)

1. **One canonical scenario**, validated against the real MCP schema once
   (`src/mcp/tools.ts`), stored in `site/src/data/scenario.ts`, reused
   verbatim — never hand-rewritten per iteration.
2. **Collapsed line, one template**:
   `✓ dispatch <taskType> … <route(s)> · <tokens in/out> · <duration> ▸`
   Route ids always named, never counted. Fanout duration = max, not sum.
3. **Expanded panel: exactly two sections, always** — REQUEST (only fields
   actually sent, real field names, bare values, no inline commentary) and
   RESULT (same terse `→` / `·` register as collapsed lines; numbered steps
   only when genuinely sequential).
4. **Vocabulary**: "route", never "model". Ids exactly as configured. No
   claims about what a route means (billing, plan, cost) anywhere in the
   demo — that's config + provider-side policy, covered in prose/FAQ only.
5. **Weight/color**: bold only for key-column cells in tables; accent color
   only on tool names; one status glyph carries state — never restated in
   words.
6. **Honesty constraints**: nothing shown that the API can't return at that
   moment. No route name while a single-mode dispatch is pending. Nothing
   that outlives the 25s default grace window resolves inline without a
   visible `graceSeconds` in its REQUEST.

## Canonical scenario (summary — full data in scenario.ts)

User asks for a backoff refactor + SLA check + test review. Agent:
1. `dispatch` (execute) → pending (`completed: false`, jobId) → transient
   status line → later `job_status` → codex_cli, 8,412 in / 2,896 out, 4m12s.
2. `dispatch` (review, fanout, `graceSeconds: 200`) → resolves inline →
   claude_code_cli (2m48s) + cursor_cli (1m56s), tokens summed on the
   collapsed line, duration shown as the max.

## Site structure

- `site/` — Astro, own package.json (library dep tree stays clean).
- `site/src/components/ToolCall.astro` — the ONLY place a tool-call line is
  rendered; rules 2/3/5/6 are enforced here structurally.
- `site/src/styles/tokens.css` — the ONLY place colors/spacing/type live.
- `pages.yml` builds `site/` and deploys `site/dist` — but it is
  `workflow_dispatch` only, so it has never run: the site is NOT live, and
  `https://fstubner.github.io/harness-dispatch/` returns 404. Run the workflow
  by hand to publish it, and point `package.json`'s `homepage` back at that URL
  once it answers.
- The pre-Astro `docs/index.html` + `docs/styles.css` have since been removed;
  `site/` is the only source of the page now. claims-check-ignore

## Page sections (content ported from the pre-Astro docs/index.html, already
accuracy-corrected at the time) claims-check-ignore

Hero (transcript) → How it works (routing/billing/safety/quota) → Setup →
Surface (all six MCP tools + both resources + REST) → FAQ → CTA/footer.
