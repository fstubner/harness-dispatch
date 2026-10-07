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
- Workspace isolation policies (`copy`, `git_worktree`), so a delegate works on
  a separate copy of the project state and its changes reach the caller's tree
  only through an explicit apply. They isolate project state and the process's
  working directory, not the host: they are not an OS sandbox, a delegate with
  shell can still reach anything the user can, and the default policy
  (`shared`) isolates nothing. What limits a delegate beyond that is its
  harness's own enforcement of the safety profile, which differs by harness.
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
| Cursor cannot serve `workspace_edit` | Its print mode grants write and shell together, on every platform. `--sandbox enabled`, the flag that would separate them, still errors "requires macOS or Linux" on Windows — live-probed 2026-08-31 against CLI 2026.08.25 — so the shipped route does not use it anywhere. Cursor's 2026 Windows-sandbox announcement covers the IDE, not the CLI. Re-probe on CLI updates |
| `usage` reports tokens, never money | [domain research] Subscription CLIs have no per-call price; pricing tokens needs a rate card that goes stale silently; prepaid API balances are not exposed by any endpoint |
| No graduated quota preference between routes | [domain research] No provider exposes a trustworthy headroom signal — subscription CLIs have none, rate-limit headers count requests not money, and Antigravity's quota API demonstrably disagrees with its own 429s. Reactive-only routing is a domain constraint, not an implementation gap |
| Spend cannot be measured, so it is never gated in real time | [domain research] Cost is knowable only after generation; there is nothing to meter before the call. `allow_paid_usage` is the only honest control available |
| Context transfer carries prior *outputs*, not understanding | [code] Chaining injects prior prompts and results, capped at 24k characters. Transmitting an orchestrator's accumulated reasoning is not tool-shaped |

## Risks

The largest is not technical, and it partially materialised in 2026. The value
proposition depends on providers permitting programmatic use of flat-rate
plans, and the vendors' terms disagree with each other and with themselves.
Quota levels are equally volatile: Anthropic changed Claude Code limits four
times between March and June 2026 with little notice. Terms below were read on
2026-10-08; they change without notice, so re-read before relying on them.

| Vendor | What the terms and docs say | Posture here |
|---|---|---|
| **Anthropic** | February 2026: subscription OAuth banned in third-party tools; April: tightened to prohibit subscriptions powering non-Anthropic agents. The Consumer Terms (effective 2025-10-08, anthropic.com/legal/consumer-terms) prohibit automated access "through a bot, script, or otherwise" except by API key "or where we otherwise explicitly permit it". The Claude Code legal page (code.claude.com/docs/en/legal-and-compliance) says limits "assume ordinary, individual usage" and that enforcement may come "without prior notice". The Help Center update of **2026-10-07** (support.claude.com/en/articles/15036540) says Max and Team plans now include monthly API credits, and that the Agent SDK, `claude -p` and third-party apps still run "with your subscription limits". The May 2026 plan to move `claude -p` onto a separate credit pool was paused on 2026-06-15 | Drive the unmodified `claude` binary as the logged-in user; never touch its tokens. Fine for one person on their own machine; heavy fanout may not count as "ordinary, individual usage", and a hosted or shared setup is outside what the terms allow |
| **Cursor** | The Acceptable Use Policy (updated 2026-08-11, cursor.com/acceptable-use-policy) prohibits access "through a bot, script, or otherwise". The headless docs (cursor.com/docs/cli/headless) say to "Use Cursor CLI in scripts and automation workflows" and show `CURSOR_API_KEY`; a Cursor staff post of 2026-08-17 on forum.cursor.com says the same. The two documents contradict each other | `cursor_cli` authenticates with the interactive Cursor login (`auth_source: product_login`, `config.default.yaml`). It sends `CURSOR_API_KEY` only when the route has its own `api_key:`, and blanks an ambient one (`src/dispatchers/generic-cli.ts`, where the child environment is built). So by default it automates an interactive login, which the AUP wording covers and the headless docs do not address; setting `api_key: ${CURSOR_API_KEY}` moves it to the documented path and to metered billing. See [docs/configuration.md](docs/configuration.md#vendor-terms) |
| **Google (Antigravity)** | The terms (antigravity.google/terms, no date shown) call using "third party software, tools, or services to access the Service" a breach, which may lead to suspension or termination, and restrict use alongside products Google does not provide. Reports of paying subscribers banned in February 2026 are secondary, not confirmed here | The highest risk of the four. `antigravity_cli` is **opt-in**: auto-detection adds it switched off and the operator enables it explicitly (`overrides.antigravity_cli.enabled: true`) |
| **OpenAI** | Welcomes outside tools: "Sign in with ChatGPT" (announced 2026-09-29, secondary sources) lets plan allowance be spent in partner tools, and OpenAI ships its own Codex plugin for Claude Code (github.com/openai/codex-plugin-cc) | Low terms risk. The risk is competitive (that plugin covers the commonest pair) and in quota changes: secondary reports say the top plan's allowance was reduced on 2026-09-29 |

The mitigation is the products-not-credentials constraint above, which keeps
this tool on the defended side of the line for Anthropic and OpenAI. It does
not cover Antigravity, whose wording objects to any third-party product, which
is why that route is opt-in. High-frequency orchestration through official CLIs
remains grey, and a terms change can still remove the reason this exists, with
no notice. Worth knowing; not mitigable in code.
