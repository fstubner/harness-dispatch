/** `dispatch`: one dispatch from the command line. */

import type { RouteHints, SafetyProfile, TaskType } from "../types.js";
import { UsageError, buildRuntime } from "./common.js";

/**
 * One dispatch from the command line — the CLI half of the `dispatch` MCP
 * tool, named to match it (`route` stays as an alias). This is the only way to
 * exercise the build in the WORKING TREE: the MCP tool runs in whatever server
 * process is already connected, a different artifact from a different moment.
 */
export async function cmdDispatch(
  prompt: string,
  configPath: string | undefined,
  opts: {
    service?: string | undefined;
    safetyProfile?: SafetyProfile | undefined;
    taskType?: TaskType | undefined;
    noFallback: boolean;
    json: boolean;
  },
): Promise<number> {
  if (!prompt) {
    throw new UsageError(
      'dispatch: missing prompt. Usage: dispatch [--service <id>] [--safety <profile>] ' +
        '[--task-type <type>] [--no-fallback] [--json] "<prompt>"',
    );
  }
  const runtime = await buildRuntime(configPath);
  const hints: RouteHints = { taskType: opts.taskType ?? "execute" };
  if (opts.safetyProfile !== undefined) hints.safetyProfile = opts.safetyProfile;

  // A named service goes through routeTo, which is what "run exactly this
  // route" means — not route() with a hint, which can still fall elsewhere.
  const { result, decision } = opts.service
    ? await runtime.router.routeTo(opts.service, prompt, [], process.cwd(), {
        ...(opts.safetyProfile !== undefined ? { safetyProfile: opts.safetyProfile } : {}),
        ...(opts.taskType !== undefined ? { taskType: opts.taskType } : {}),
      })
    : await runtime.router.route(prompt, [], process.cwd(), {
        hints,
        maxFallbacks: opts.noFallback ? 0 : 2,
      });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ result, routing: decision ?? null }, null, 2)}\n`,
    );
    return result.success ? 0 : 1;
  }
  if (decision) {
    const beat = decision.candidates?.length
      ? ` [${decision.candidates.map((c) => `${c.route} ${c.score}`).join(", ")}]`
      : "";
    // Name the MODEL, not just the route: a route id names a harness, not
    // what answered. `model` is genuinely undefined for a route that
    // configures none — the harness runs its own default, a real answer and
    // not a missing value — so it is said in words rather than printed as an
    // empty `model=`, and delimited so it does not run into the
    // parenthesised reason that follows.
    const model = decision.model !== undefined ? decision.model : "<harness default>";
    process.stderr.write(
      `dispatch: ${decision.service} model=${model} (${decision.reason})${beat}\n`,
    );
  }
  process.stdout.write(result.output);
  if (!result.output.endsWith("\n")) process.stdout.write("\n");
  if (!result.success) {
    process.stderr.write(`${result.error ?? "routing failed"}\n`);
    return 1;
  }
  return 0;
}
