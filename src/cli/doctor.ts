/** `doctor`: check the install, config and every route. */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readHttpToken, tokenPath } from "../auth.js";
import { AUTO_DETECT_COMMANDS } from "../config.js";
import { commandAvailable } from "../dispatchers/shared/which-available.js";
import { codexLoginState } from "../dispatchers/shared/harness-login.js";
import { clientConfigLocations, inspectClientEntries } from "../mcp-clients.js";
import { resolveRunnerPath } from "../jobs.js";
import { NEVER_SUCCEEDED_MIN_CALLS } from "../route-policy.js";
import { buildStatus } from "../status.js";
import { stateRoot } from "../state-dir.js";
import { buildRuntime } from "./common.js";

/**
 * Can we actually persist state? Breaker cooldowns, quota counters and job
 * records all live here, and every write path swallows its own failures so a
 * dispatch is never lost to a bookkeeping problem — this check buys back the
 * silence that costs.
 */
function stateDirWritable(): { ok: boolean; detail: string } {
  const dir = stateRoot();
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, "", { mode: 0o600 });
    rmSync(probe, { force: true });
    return { ok: true, detail: `writable: ${dir}` };
  } catch (err) {
    return {
      ok: false,
      detail:
        `NOT writable: ${dir} (${err instanceof Error ? err.message : String(err)}). ` +
        `Breaker cooldowns and usage counters will not persist, and jobs may be ` +
        `reported as orphaned after they have actually succeeded.`,
    };
  }
}

export async function cmdDoctor(
  configPath: string | undefined,
  opts: { json: boolean; live: boolean; allowPaid: boolean },
): Promise<number> {
  const runtime = await buildRuntime(configPath);
  if (opts.allowPaid) {
    for (const svc of Object.values(runtime.config.services)) {
      svc.allowPaidUsage = true;
    }
  }
  const status = await buildStatus(
    runtime.config,
    runtime.dispatchers,
    runtime.quota,
    runtime.router,
    runtime.leaderboard,
  );
  // Must agree with package.json engines (>=22.22.2) and the README:
  // disagreement fails `doctor` on a runtime where dispatch works correctly.
  const [nodeMajor, nodeMinor, nodePatch] = process.versions.node
    .split(".")
    .map((n) => Number(n) || 0);
  const nodeOk =
    (nodeMajor ?? 0) > 22 ||
    ((nodeMajor ?? 0) === 22 &&
      ((nodeMinor ?? 0) > 22 || ((nodeMinor ?? 0) === 22 && (nodePatch ?? 0) >= 2)));
  const configuredCommands = new Set(
    status.routes
      .map((route) => route.command)
      .filter((command): command is string => typeof command === "string")
      .map((command) => path.basename(command).replace(/\.(cmd|exe)$/i, "")),
  );
  const unconfiguredHarnesses =
    runtime.config.detectionRan === false
      ? Object.values(AUTO_DETECT_COMMANDS).filter(
          (command) => commandAvailable(command) && !configuredCommands.has(command),
        )
      : [];
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "node",
      ok: nodeOk,
      detail: nodeOk
        ? `Node ${process.versions.node}`
        : `Node ${process.versions.node} — harness-dispatch needs >=22.22.2`,
    },
    {
      name: "config",
      ok: Object.keys(runtime.config.services).length > 0,
      // Names the file: `configure` run from one directory and `doctor` from
      // another can load different things, so "which config is this looking
      // at" has to be answerable from the output.
      detail:
        `${Object.keys(runtime.config.services).length} configured route(s)` +
        (configPath === undefined
          ? " (no config file found; shipped defaults with auto-detected harnesses)"
          : runtime.config.detectionRan === false
            ? ` from ${path.resolve(configPath)}`
            : // Detection ran, for one of two reasons: the file defines no
              // routes at all, or it defines some AND asks for detection with
              // `detect: true`.
              (runtime.config.detect === true
                ? ` from ${path.resolve(configPath)} plus auto-detected harnesses (detect: true)`
                : ` auto-detected — ${path.resolve(configPath)} defines no routes of its own`)),
    },
    // This one DOES fail, unlike the advisory git check below: a client entry
    // naming a path that is not there is intended by no setup, and is
    // invisible from the client side — a client that cannot spawn its server
    // simply has no tools, which looks identical to never having installed
    // anything. Not-configured is NOT a failure; only a broken entry is.
    (() => {
      const entries = inspectClientEntries();
      const broken = entries.filter((e) => e.missingPaths.length > 0);
      if (entries.length === 0) {
        // Name the client that IS here, so "not registered" reads as the
        // next step rather than as "nothing to register with".
        const present = clientConfigLocations()
          .filter((c) => c.commands.some((cmd) => commandAvailable(cmd)))
          .map((c) => c.client);
        return {
          name: "mcp-clients",
          ok: true,
          detail:
            present.length > 0
              ? `${present.join(", ")} installed but harness-dispatch is not registered with it — ` +
                "run `harness-dispatch connect`"
              : "not registered with any MCP client this tool knows how to read " +
                "(Claude Code, Cursor), and none is installed — run `harness-dispatch connect` " +
                "after installing one",
        };
      }
      return {
        name: "mcp-clients",
        ok: broken.length === 0,
        detail:
          broken.length === 0
            ? entries.map((e) => `${e.client}: ${e.entry} resolves`).join("; ")
            : broken
                .map(
                  (e) =>
                    // "references", not "launches ... from": missingPaths
                    // holds any path the entry names that is not there, and
                    // that is routinely the `--config` argument rather than
                    // the launch binary.
                    `${e.client} (${e.file}) references a path that does not exist: ` +
                    `${e.missingPaths.join(", ")} (entry: ${e.entry}) — that client has been ` +
                    "getting NO tools from this server, silently. `harness-dispatch connect` " +
                    "rewrites the entry.",
                )
                .join(" | "),
      };
    })(),
    // Not required to dispatch. The `workspace` tool shells out to git for
    // diff/apply, so without it an isolated run's changes are recoverable
    // only by hand via workspaceRoot in the response.
    //
    // `ok: true` UNCONDITIONALLY, matching http-auth / billing-policy /
    // safety-policy below: doctor's exit code is the sum of every check, so a
    // false here would fail a supported install for any script gating on it.
    // The advice belongs in `detail`.
    {
      name: "git",
      ok: true,
      detail: commandAvailable("git")
        ? "available — workspace diff/apply and git_worktree isolation can run"
        : "NOT FOUND — optional. Dispatch still works, but the `workspace` tool " +
          "cannot diff or apply an isolated run's changes, and the git_worktree " +
          "policy is unavailable. Retrieve changes by hand from the " +
          "workspaceRoot in the dispatch response.",
    },
    {
      name: "config-warnings",
      ok: (runtime.config.configWarnings?.length ?? 0) === 0,
      detail:
        runtime.config.configWarnings && runtime.config.configWarnings.length > 0
          ? runtime.config.configWarnings.join(" | ")
          : "no unrecognized config entries",
    },
    {
      // Saved state that could not be read — an unreadable breaker record, or
      // usage counters that are not reaching disk. Not a config problem, so
      // `configWarnings` above does not cover it.
      name: "saved-state",
      ok: (status.stateWarnings?.length ?? 0) === 0,
      detail:
        status.stateWarnings && status.stateWarnings.length > 0
          ? status.stateWarnings.join(" | ")
          : "readable",
    },
    {
      name: "routes",
      ok: status.ready.length > 0,
      // When nothing is ready, say what was looked for. "0 ready route(s)" on
      // its own leaves a new user with no idea whether the tool is broken or
      // simply has nothing to route to, and no hint what to install.
      detail:
        (status.ready.length > 0
          ? // Trailing period so this reads as a sentence when the
            // installed-but-unconfigured note is appended after it.
            `${status.ready.length} ready route(s).`
          : `0 ready route(s). Looked for these harness CLIs on PATH: ` +
            `${Object.values(AUTO_DETECT_COMMANDS).join(", ")}. ` +
            `Install one, or add a route to config.yaml (endpoints: need no CLI).`) +
        // A config that lists its own routes is authoritative, so a harness
        // installed later is simply absent. The PATH hint above only fires at
        // zero routes, which would leave that case unexplained.
        (unconfiguredHarnesses.length > 0
          ? ` Installed but not in this config: ${unconfiguredHarnesses.join(", ")} — add ` +
            `\`detect: true\` to ${configPath !== undefined ? path.resolve(configPath) : "the config"} ` +
            `to merge them, or a clis: entry for each.`
          : ""),
    },
    {
      // Unchecked, an unwritable state directory surfaces only as jobs
      // reporting "the dispatch server exited before the run finished" — a
      // false cause, 90s after the work actually succeeded.
      name: "state-dir",
      // Called ONCE: each call creates and deletes a probe file.
      ...stateDirWritable(),
    },
    {
      // Whether dispatches will actually be detached.
      //
      // `resolveRunnerPath()` returning undefined is not an error — it is the
      // signal to run the job IN-PROCESS, which is right for an unbuilt
      // checkout and wrong everywhere else: the concurrency cap is enforced by
      // the supervisor pool, so in-process mode silently removes the bound
      // that exists to prevent an OOM. Dispatch says so once on stderr, which
      // is not somewhere "am I actually capped?" can be answered from.
      name: "job-runner",
      ok: resolveRunnerPath() !== undefined,
      detail:
        resolveRunnerPath() !== undefined
          ? "found; jobs run detached and the concurrency cap applies"
          : "dist/job-runner.js not found — jobs will run IN-PROCESS, which " +
            "removes the max_concurrent_runs cap and does not survive a server " +
            "restart. Run `npm run build`, or reinstall the package.",
    },
    {
      name: "http-auth",
      ok: true,
      detail: (await readHttpToken())
        ? `token configured at ${tokenPath()} or HARNESS_DISPATCH_HTTP_TOKEN`
        : "no token yet; run harness-dispatch auth show or serve to create one before using HTTP",
    },
  ];
  const blocked = status.skippedRoutes.filter(
    (skip) => skip.code === "paid_blocked" || skip.code === "unknown_billing",
  );
  // A ready route is one whose CLI is on PATH, which says nothing about
  // whether the CLI can actually make a request: an installed,
  // never-logged-in Codex passes routes, billing and safety, then fails the
  // first dispatch with a raw OpenAI 401 that never mentions `codex login`.
  // The CLI is asked directly (see harness-login.ts for why not the
  // credential file), and only a definite "not logged in" fails the check.
  const codexRoutes = status.routes.filter(
    (route) => status.ready.includes(route.id) && route.harness === "codex" && route.command,
  );
  const loginStates = await Promise.all(
    codexRoutes.map(async (route) => ({ route, state: await codexLoginState(route.command!) })),
  );
  const loggedOut = loginStates.filter((entry) => entry.state === "logged_out");
  // A route that has NEVER succeeded is worth saying out loud: the breaker is
  // about recent failure and forgets after its cooldown, so a route that is
  // simply dead — a host that no longer resolves, a key that was revoked —
  // keeps being selected, failing, and falling back forever, costing every
  // dispatch one doomed attempt.
  //
  // Advisory, never a failure: a fresh install has no calls at all, and a
  // route can legitimately fail its first few. The threshold is about having
  // enough evidence to mention it, not about being sure.
  const deadRoutes = status.routes
    // Ready routes AND routes skipped for exactly this reason: `ready`
    // excludes anything the policy skipped, and the dead-route skip is a
    // policy skip, so reading `ready` alone would drop the very route this
    // check exists to name.
    .filter(
      (route) =>
        status.ready.includes(route.id) || route.skipped?.code === "never_succeeded",
    )
    .map((route) => ({
      id: route.id,
      calls: route.quota.localCallCount ?? 0,
      successes: route.quota.localSuccessCount ?? 0,
    }))
    .filter((r) => r.calls >= NEVER_SUCCEEDED_MIN_CALLS && r.successes === 0);
  checks.push({
    name: "route-health",
    ok: true,
    detail:
      deadRoutes.length === 0
        ? "no ready route has failed every call it has been given"
        : deadRoutes
            .map(
              (r) =>
                `${r.id} has never succeeded (${r.calls} calls, 0 successes), so the router ` +
                `no longer scores it. Naming it with \`service\` still runs it and one ` +
                `success re-admits it. Check the endpoint or credential, or disable it.`,
            )
            .join(" | "),
  });

  checks.push({
    name: "harness-login",
    ok: loggedOut.length === 0,
    detail:
      loginStates.length === 0
        ? "no ready route has a login state this tool knows how to ask for (Codex only, today)"
        : loggedOut.length > 0
          ? `${loggedOut.map((entry) => entry.route.id).join(", ")}: codex reports "Not logged in" — ` +
            "run `codex login` (or `codex login --with-api-key`), or every dispatch to it fails " +
            "with 401 Unauthorized from OpenAI"
          : loginStates
              .map(
                (entry) =>
                  `${entry.route.id}: ${entry.state === "logged_in" ? "logged in" : "could not determine (codex login status gave no answer)"}`,
              )
              .join("; "),
  });
  checks.push({
    name: "billing-policy",
    ok: true,
    detail:
      blocked.length === 0
        ? "all ready routes satisfy billing policy"
        : `${blocked.length} route(s) intentionally blocked by paid/unknown billing policy`,
  });

  const unsafe = status.routes.filter(
    (route) => route.effectiveSafetyProfile === "full_auto" && route.safetyProfile !== "full_auto",
  );
  checks.push({
    name: "safety-policy",
    ok: true,
    detail:
      unsafe.length === 0
        ? "all ready routes satisfy requested safety profile"
        : `${unsafe.length} route(s) require full_auto safety and are skipped unless requested`,
  });

  let liveProbe:
    | {
        route: string;
        success: boolean;
        output: string;
        error?: string;
      }
    | undefined;
  if (opts.live) {
    const { result } = await runtime.router.route(
      "Reply with exactly: harness-dispatch live probe ok. Do not inspect or modify files.",
      [],
      process.cwd(),
      { hints: { taskType: "local" }, maxFallbacks: 0 },
    );
    liveProbe = {
      route: result.service,
      success: result.success,
      output: result.output,
    };
    if (result.error !== undefined) liveProbe.error = result.error;
    checks.push({
      name: "live-probe",
      ok: result.success,
      detail: result.success
        ? `routed through ${result.service}`
        : `${result.service}: ${result.error ?? "probe failed"}`,
    });
  } else {
    checks.push({
      name: "live-probe",
      ok: true,
      detail: "skipped; pass --live to consume quota and validate dispatch",
    });
  }

  const payload = { ok: checks.every((check) => check.ok), checks, status, liveProbe };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write("harness-dispatch doctor\n\n");
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}\n`);
    }
  }
  return payload.ok ? 0 : 1;
}
