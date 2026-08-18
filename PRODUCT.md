# PRODUCT

## Purpose

**Let a primary coding agent farm work out to other models.**

The orchestrator — Claude Code, or anything else speaking MCP — stays in
charge of judgement and review, and hands the execution-heavy parts to whichever
harness is best placed to run them: Codex, Cursor, Antigravity, a local model,
or an HTTP endpoint.

The value is delegation capacity: parallel work the orchestrator does not have
to hold in its own context, and independent opinions from genuinely different
models. Cost safety is a guardrail that makes delegating safe to do casually —
it is not the point.

> This distinction has been got wrong before, including by an assistant working
> on this codebase, which read the elaborate billing machinery and concluded the
> product was "never spend metered money by accident". That is a constraint the
> product respects, not the job it does. If you are deciding what to build next,
> optimise for *how much work can be farmed out and how good it is when it comes
> back*.

## Users

One primary user shape: a developer running an agentic main loop who holds
several flat-rate AI coding subscriptions and wants them used rather than idle.
Technical, comfortable with a config file, running on their own machine.

Secondary: the same person's automation — CI jobs, cron, scripts — reaching the
same routing through the HTTP surface.

The **actual consumer of the interface is an agent**, not a human. The MCP tool
surface is therefore the product surface, and its ergonomics matter more than
the YAML reference. Humans mostly interact through `status`, `doctor`, and
`usage` when something looks wrong.

## Success

The product is working when:

1. The orchestrator delegates without hesitation, because a delegated task is
   cheap, safe, and does not risk surprise spend.
2. Delegated work comes back usable, without the orchestrator having to redo
   it or re-read the whole thing.
3. Several tasks run at once without exhausting the machine.
4. Nothing is ever billed that the caller did not explicitly allow.
5. A route being busy, missing, or rate limited degrades gracefully — the
   dispatch waits or goes elsewhere, and nothing is silently lost.

Counter-signals, each observed at least once in this codebase:

- A route that is configured, reported ready, and never actually used.
- Numbers in `usage` that make a healthy route look unreliable.
- A safety or isolation guarantee that reads correctly in the source and does
  nothing at runtime.

## MVP scope

In scope:

- Routing a prompt to the best available harness by tier, weight, capability,
  quota, and safety.
- Background jobs that survive the MCP request timeout, with partial output
  while running.
- Fan-out to several routes for independent opinions.
- Workspace isolation policies, so a delegate cannot damage the caller's tree.
- Billing classification and opt-in gating for anything that can cost money.
- Chaining: a dispatch can build on earlier jobs' results.

Out of scope:

- Being an LLM gateway. LiteLLM and OpenRouter route API calls; this routes
  *agent processes* with file access. That is the differentiator, and the
  moment this becomes a generic proxy it is competing where it cannot win.
- Hosting, multi-tenancy, or anything requiring a server the user does not own.
- Judging output quality. The orchestrator reviews; this delivers.

## Constraints

- **Local-first.** Prompts and outputs reach only the harnesses the user
  configured. The default install makes no other network call.
- **Never spend money silently.** Paid usage requires explicit opt-in per
  route; unknown billing is treated as paid.
- **Safety profiles are limits, not capabilities.** A route is skipped rather
  than given more access than the caller asked for.
- **Subscription-backed CLIs are heavyweight processes**, not fan-outable HTTP
  calls. Concurrency is bounded by memory, not cores.
- **Platform parity matters.** Windows is a first-class target; several defects
  here have been Windows-only or Windows-masked.

## Known limits

| Limit | Why it stands |
|---|---|
| Cursor cannot serve `workspace_edit` on Windows | Its editing mode grants shell too; `--sandbox` is POSIX-only |
| No graduated quota preference for CLI routes | CLIs do not emit usage signals; the breaker catches exhaustion, but the router cannot prefer the less-depleted subscription |
| Context transfer carries prior *outputs*, not understanding | Transmitting an orchestrator's accumulated reasoning is not tool-shaped |

## Risks

The largest is not technical. The value proposition depends on providers
continuing to permit programmatic use of flat-rate plans. A terms change or a
rate-limit policy change at any provider removes the reason this exists, with
no notice. Nothing in the codebase mitigates that; it is worth knowing.
