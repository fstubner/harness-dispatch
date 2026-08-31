# PRODUCT

Provenance: stated-by-human — reviewed section by section with Felix on
2026-08-31, replacing a version that had been extracted from the code. Every
judgement below is his; the wording is not. The known limits were re-verified
on the same day rather than carried forward (method noted per row).

## Purpose

**Let a primary coding agent farm work out to other models.**

The orchestrator — Claude Code, or anything else speaking MCP — stays in
charge of judgement and review, and hands the execution-heavy parts to
whichever route is best placed to run them: Codex, Cursor, Antigravity, a
local model, or an API endpoint.

The value is delegation capacity: parallel work the orchestrator does not have
to hold in its own context, and independent opinions from genuinely different
models. Cost safety is a guardrail that makes delegating safe to do casually —
it is not the point, and most of the real gate lives at the provider (see
Constraints).

> This distinction has been got wrong before, including by an assistant working
> on this codebase, which read the elaborate billing machinery and concluded the
> product was "never spend metered money by accident". That is a constraint the
> product respects, not the job it does. If you are deciding what to build next,
> optimise for *how much work can be farmed out and how durable it is when it
> comes back*.

## Users

Anyone who wants one or more of:

1. **Mixed-fleet dispatch** — automated routing across local subscription CLIs,
   with metered/free API models and local models in the same mix.
2. **Agent-to-agent workflows** — one agent reviewing or building on another's
   work, to reach a better outcome than either alone.
3. **Subscription saturation** — keeping flat-rate coding plans busy without
   spilling into metered usage.
4. **HTTP automation** — the same routing reachable from CI, cron, and scripts.

The original user shape (one developer, own machine, several idle
subscriptions) is still the centre of gravity, but this is a published package
and `connect` writes into other people's client configs — the design must hold
for users who did not write this code and will not read it.

The **actual consumer of the interface is an agent**, not a human. The MCP tool
surface is therefore the product surface, and its ergonomics matter more than
the YAML reference. Humans mostly interact through `status`, `doctor`, and
`usage` when something looks wrong.

## Success

The product is working when:

1. The orchestrator delegates without hesitation, because a delegated task is
   cheap in **effort** — a tool call and some waiting, not context or
   attention.
2. **Delegated work is durable.** A dispatch never dies returning nothing: at
   worst it fails and hands back its latest progress, so the caller can
   inspect and salvage what is useful. A wasted attempt with no trail is the
   defining failure. Returning something directly useful is the goal;
   returning *nothing* is the sin.
3. Several tasks run at once without exhausting the machine.
4. A route being busy, missing, or rate limited degrades gracefully — the
   dispatch waits or goes elsewhere, and nothing is silently lost.

Counter-signals, each observed at least once in this codebase:

- A route that is configured, reported ready, and never actually used.
- Numbers in `usage` that make a healthy route look unreliable.
- A safety or isolation guarantee that reads correctly in the source and does
  nothing at runtime.
- A refusal, warning, or error shaped like success.

## MVP scope

In scope:

- Routing a prompt to the best available route by tier, weight, capability,
  quota, and safety.
- Background jobs that survive the MCP request timeout, with partial output
  while running — the durability criterion above is implemented here.
- Fan-out to several routes for independent opinions.
- Workspace isolation policies, so a delegate cannot damage the caller's tree.
- Billing classification and opt-in gating for anything that can cost money.
- Chaining: a dispatch can build on earlier jobs' results.
- API endpoint routes as full members of the mix, within what they can
  structurally do: an endpoint has no agent loop and no file access, so it is
  read-only by construction — it plans, reviews, and gives second opinions,
  and cannot execute. That is the design, not a gap.

Out of scope:

- **Being an LLM gateway.** LiteLLM and OpenRouter exist to route other
  clients' API calls; the moment this becomes a generic proxy it is competing
  where it cannot win. This routes *agent processes with file access*, and
  endpoint routes are one kind of route inside that mix — not the product's
  centre of gravity.
- Hosting, multi-tenancy, or anything requiring a server the user does not own.
- Judging output quality. The orchestrator reviews; this delivers.

## Constraints

- **Local-first.** Prompts and outputs reach only the routes the user
  configured. The default install makes no other network call.
- **Drive official products, never their credentials.** Subscription harnesses
  are invoked as the CLIs their vendors ship; their OAuth tokens are never
  extracted or reused. This is a compliance boundary, not a convenience:
  Anthropic banned subscription-credential use in third-party tools in
  February 2026, and driving the official CLI locally is the defended path.
- **Route billing is declared, not enforced here.** Money moves only through a
  standing consent on the provider's own side — overage enabled, credits
  purchased, auto-reload on — and no API exposes that state. `allow_paid_usage`
  records the user's declaration of it; routes without it are skipped when
  they could bill. The one place this gate is load-bearing is metered API keys
  with auto-reload, where spend is effectively unbounded. Do not build as
  though this tool polices spend; it mirrors a decision made elsewhere.
- **Safety profiles are limits, not capabilities.** A route is skipped rather
  than given more access than the caller asked for, and a declaration cannot
  conjure an enforcement flag the harness does not have.
- **Subscription-backed CLIs are heavyweight processes**, not fan-outable HTTP
  calls. Concurrency is bounded by memory, not cores.
- **Platform parity matters.** Windows is a first-class target; several defects
  here have been Windows-only or Windows-masked.

## Known limits

Each verified 2026-08-31 rather than carried forward; method in brackets.

| Limit | Why it stands |
|---|---|
| Cursor cannot serve `workspace_edit` on Windows | `--sandbox enabled` still errors "requires macOS or Linux" — live-probed today against CLI 2026.08.25 (it fails locally, before any dispatch). Cursor's 2026 Windows-sandbox announcement covers the IDE, not the CLI. Re-probe on CLI updates |
| `usage` reports tokens, never money | [domain research] Subscription CLIs have no per-call price; pricing tokens needs a rate card that goes stale silently; prepaid API balances are not exposed by any endpoint |
| No graduated quota preference between routes | [domain research] No provider exposes a trustworthy headroom signal — subscription CLIs have none, rate-limit headers count requests not money, and Antigravity's quota API demonstrably disagrees with its own 429s. Reactive-only routing is a domain constraint, not an implementation gap |
| Spend cannot be measured, so it is never gated in real time | [domain research] Cost is knowable only after generation; there is nothing to meter before the call. `allow_paid_usage` is the only honest control available |
| Context transfer carries prior *outputs*, not understanding | [code] Chaining injects prior prompts and results, capped at 24k characters. Transmitting an orchestrator's accumulated reasoning is not tool-shaped |

## Risks

The largest is not technical, and it partially materialised in 2026. The value
proposition depends on providers permitting programmatic use of flat-rate
plans, and Anthropic moved against that ground twice this year: February
(subscription OAuth banned in third-party tools), April (tightened to prohibit
subscriptions powering non-Anthropic agents), then a May 14 plan to split
`claude -p` into a separate credit pool — **paused on June 15 before taking
effect**. OpenAI went the opposite direction in the same window. Quota levels
are equally volatile: Anthropic changed Claude Code limits four times between
March and June 2026 with little notice.

The mitigation is the products-not-credentials constraint above, which keeps
this tool on the defended side of the line — but high-frequency orchestration
through official CLIs remains grey, and a terms change can still remove the
reason this exists, with no notice. Worth knowing; not mitigable in code.
