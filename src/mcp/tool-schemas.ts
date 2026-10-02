/**
 * The MCP input contract: what the six tools accept, and what they refuse.
 *
 * These schemas ARE the safety boundary, which is why they live apart from the
 * handlers that run after them: the SDK validates arguments against them BEFORE
 * any handler runs, so a key absent here is a key silently stripped — and a
 * stripped safety setting runs the dispatch with more access than the caller
 * asked for.
 *
 * Keys that are NOT fields but that a caller will plausibly send (a snake_case
 * spelling, a hint put at the top level) are refused by the near-miss guard in
 * near-miss-guard.ts, which sees the raw arguments before the SDK strips them.
 * They used to be `z.never()` fields here; that put 15 properties into every
 * session's tools/list for keys that only exist to be rejected.
 */

import { z } from "zod";

/**
 * setTimeout's real ceiling. Above it Node emits TimeoutOverflowWarning and
 * CLAMPS TO 1ms, so the longest timeout a caller can ask for becomes the
 * shortest one possible: the child is SIGTERMed on the first tick and the run
 * is recorded as a route failure with breaker credit. `.int()` alone stops at
 * Number.MAX_SAFE_INTEGER, far past the point it breaks. http/parse.ts mirrors
 * this.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A string that ends up in an argv array. A NUL fails deep inside cross-spawn
 * with "The argument 'args[N]' must be a string without null bytes" — the raw
 * Node internal these boundary rejections exist to replace.
 */
const noNul = (v: string) => !v.includes("\u0000");
const NO_NUL_MESSAGE = "must not contain NUL bytes";

export const taskTypeSchema = z.enum(["execute", "plan", "review", "local"]);
export const safetyProfileSchema = z.enum(["read_only", "workspace_edit", "full_auto"]);
export const workspacePolicySchema = z.enum(["shared", "shared_locked", "copy", "git_worktree"]);
export const routePolicySchema = z.enum(["standard", "local_only", "approval_required", "blocked"]);

export const publicHintsSchema = z
  .object({
    model: z
      .string()
      // Blank is not "no preference" — it survives as a value and wins the `??`
      // against the route's configured model, so the route runs with no --model
      // flag and reports model: "". Whitespace does the same while also reaching
      // the harness as a real argument.
      //
      // BOTH, not just the refine: .min(1) is the only half that reaches the
      // advertised JSON Schema as `minLength: 1`, so without it a
      // schema-validating client spends a round trip on a -32602.
      .min(1, "hints.model must not be empty — omit it entirely for no preference")
      // `v === ""` short-circuits so .min(1) is the only rule that reports on
      // an empty string; without it both fire and the caller reads the same
      // sentence twice in one error payload.
      .refine(
        (v) => v === "" || v.trim() !== "",
        "hints.model must not be empty — omit it entirely for no preference",
      )
      .refine(noNul, `hints.model ${NO_NUL_MESSAGE}`)
      .optional()
      .describe(
        "Preferred model name, e.g. 'gpt-5.6-sol' (`usage` lists each route's models). " +
          "Routes that declare it get a scoring boost; anything else goes to the harness " +
          "as an override, unvalidated, so an unknown name can fail at dispatch. Pair it " +
          "with `service` for the route it belongs to. A value that names a configured " +
          "route id steers routing instead of being sent as a model: that route runs its " +
          "own default model, wherever it sits in the tiers, and routing falls back if it " +
          "cannot run (`service` is how you force one route with no fallback). With " +
          "`service` set, only that route's own id is treated this way; another route's " +
          "id is sent as a model. In the response, routing.modelHintDropped: true means " +
          "it was used for routing only, and routing.modelHintMatched: false means the " +
          "picked route does not declare it, so it was forwarded blind. Ignored in " +
          "fanout — use `models`.",
      ),
    taskType: taskTypeSchema
      .optional()
      .describe(
        "Kind of work: 'execute' (write/modify code, run commands), 'plan' " +
          "(architecture/design, no edits), 'review' (critique code, no edits), 'local' " +
          "(trivial/mechanical — picks a local endpoint wherever it sits, ahead of the " +
          "usual tier order, and falls back to normal routing when you have none). " +
          "ALWAYS set this: when " +
          "omitted, per-task capability weighting and model escalation are disabled and " +
          "routing quality degrades.",
      ),
    preferLargeContext: z
      .boolean()
      .optional()
      .describe("Boost routes with very large context windows (for huge-codebase reads)."),
    safetyProfile: safetyProfileSchema
      .optional()
      .describe(
        "Maximum permission the routed harness may use: 'read_only' (inspect only — use " +
          "for review/plan), 'workspace_edit' (default; may edit files in workingDir), " +
          "'full_auto' (unrestricted shell — only when explicitly needed). Routes that " +
          "cannot honor the requested profile are skipped. Each harness enforces the " +
          "profile itself, with different strength (an OS sandbox for Codex, in-process " +
          "permission rules for Claude Code and Cursor); it is a limit passed to the " +
          "harness, not a sandbox harness-dispatch imposes.",
      ),
    workspacePolicy: workspacePolicySchema.optional().describe("Workspace execution policy."),
    routePolicy: routePolicySchema
      .optional()
      .describe(
        "Operational routing policy: 'standard' (default), 'local_only' (never leave the " +
          "machine), 'approval_required' (BLOCKS non-local routes — it is a restriction, " +
          "not an approval grant), 'blocked' (dry-run: block everything).",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(
        MAX_TIMEOUT_MS,
        `timeoutMs must be at most ${MAX_TIMEOUT_MS} (setTimeout clamps anything larger to 1ms)`,
      )
      .optional()
      .describe(
        "Override the background run's hard ceiling (milliseconds). Every dispatch " +
          "runs as a background job with a generous 60-minute default meant to catch a " +
          "genuinely hung process, not to cap a slow-but-healthy run — raise this for " +
          "a task you expect to run past an hour. This changes when the harness itself " +
          "gives up, not how long the inline grace window waits (that's `graceSeconds`).",
      ),
  })
  // STRICT, and this is a safety control, not tidiness. zod drops unknown keys
  // by default, and the same setting is spelled `safety_profile` in config.yaml
  // and `safetyProfile` here, so without this the slip is silently discarded:
  // `hints: { safety_profile: "read_only" }` runs a full_auto route at
  // full_auto, with no restriction and no warning.
  .strict()
  .describe("Public routing hints.");

export const workingDirDescription =
  "Absolute path to the project the task is about. EFFECTIVELY REQUIRED: when omitted, " +
  "the task runs in the router server's own working directory — almost never the " +
  "project you mean. Always pass the caller's project root.";

/** Inline grace window: how long `dispatch` waits for the background run before returning a pollable jobId instead of the full result. */
export const DEFAULT_GRACE_SECONDS = 25;

/**
 * Cap on `files` per dispatch. Not a performance limit — each entry's parent
 * directory becomes an `--add-dir` grant on CLI routes (generic-cli.ts
 * includedDirectories -> {{file_dirs}}), so an unbounded list is an unbounded
 * set of directories handed to a coding agent. 64 is far above any real prompt.
 */
/** The only jobId shape jobs.ts produces; shared by both tools. */
export const JOB_ID_RE = /^job-\d+-[0-9a-f]{8}$/;

export const MAX_CONTEXT_FILES = 64;

/**
 * Cap on prior jobs referenced by one dispatch. Each one costs a disk read and
 * a slice of the delegate's context window; jobs.ts caps the rendered TEXT as
 * well, and this bounds the work done to produce it.
 */
export const MAX_CONTEXT_JOBS = 16;

export const dispatchInputShape = {
  prompt: z
    .string()
    // Rejected here rather than at the harness: an empty prompt otherwise
    // reaches a real CLI, which spawns, fails with its own usage message, and
    // leaves a consumed route call behind.
    .min(1, "prompt must not be empty")
    // Whitespace is empty for this purpose, as the HTTP surface also says
    // (`!prompt.trim()` → 400). It passes .min(1) and spends a real route call
    // producing nothing.
    .refine((v) => v === "" || v.trim() !== "", "prompt must not be empty")
    // A NUL byte otherwise fails deep inside cross-spawn with "The argument
    // 'args[2]' must be a string without null bytes" — caught rather than a
    // crash, but a raw Node internal where a boundary rejection belongs.
    .refine((v) => !v.includes("\u0000"), "prompt must not contain NUL bytes")
    .describe(
      "The coding task or question. Every dispatch starts as a background job " +
        "immediately; if it finishes within the grace window you get the full result " +
        "inline, otherwise you get a jobId — check on it with the `job_status` tool. " +
        "Either way nothing is ever lost to a timeout.",
    ),
  mode: z
    .enum(["single", "fanout"])
    .optional()
    .default("single")
    .describe(
      "'single' routes to the one best-fit harness. 'fanout' runs the prompt on " +
        "MULTIPLE routes in parallel for independent perspectives — without `models` it " +
        "hits every eligible route and consumes quota on each; prefer passing an " +
        "explicit `models` list. Write-capable fanout requires workspacePolicy 'copy' " +
        "or 'git_worktree'. Fanout results that outlive the grace window each return " +
        "their own jobId to poll individually.",
    ),
  contextJobs: z
    .array(z.string().regex(JOB_ID_RE, "must look like job-<timestamp>-<8 hex chars>"))
    .max(MAX_CONTEXT_JOBS)
    .optional()
    .describe(
      "jobIds of earlier dispatches whose results this one should build on. Their " +
        "prompts and outputs are rendered into this prompt directly, so a follow-up " +
        "step can see what came before WITHOUT you reading it into your own context " +
        "and re-summarising it. Use this to chain delegated work.",
    ),
  files: z
    .array(z.string().refine(noNul, NO_NUL_MESSAGE))
    .max(MAX_CONTEXT_FILES)
    .optional()
    .describe(
      `Absolute file paths to snapshot and include as context (max ` +
        `${MAX_CONTEXT_FILES}); a relative path is resolved against workingDir. A path ` +
        `outside workingDir is still sent, except to a remote endpoint route, which ` +
        `refuses it (paste the content into the prompt instead). ` +
        `For CLI routes the PARENT DIRECTORY of such a path is also granted to the agent via ` +
        `--add-dir, so it escapes an isolated workspace — the response carries ` +
        `a warning naming the directories when that happens.`,
    ),
  workingDir: z.string().optional().describe(workingDirDescription),
  workspacePolicy: workspacePolicySchema.optional().describe("Workspace execution policy."),
  hints: publicHintsSchema.optional(),
  models: z
    .array(z.string().refine(noNul, NO_NUL_MESSAGE))
    // An EXPLICIT empty array is a caller mistake, and the most expensive one
    // this field can carry: treated as "omitted" it fans out to every eligible
    // route, one arm per configured route. A caller who wrote `models: []`
    // built a list and it came out empty; they did not ask for everything.
    // Omitting the field is how you ask for that, and it stays a deliberate
    // keystroke rather than the result of a filter matching nothing.
    .min(
      1,
      "models: [] selects no routes. Omit `models` entirely to fan out to every " +
        "eligible route (expensive — one dispatch per route), or name at least one. " +
        "An empty list is usually a filter that matched nothing.",
    )
    .optional()
    .describe(
      "Route ids or model names to fan out to (fanout mode only). This is the ONLY " +
        "field that narrows which routes fanout hits — `hints.model` is ignored " +
        "entirely in fanout mode (not used for selection, not forwarded to any " +
        "dispatch); it only does anything in single mode. An empty array is " +
        "REFUSED rather than treated as 'all routes' — omit the field for that. " +
        "Get valid ids from the `usage` tool.",
    ),
  service: z
    .string()
    .optional()
    .describe(
      "Route id to run, exactly as `usage` lists it (e.g. 'codex_cli'; ids differ per " +
        "machine). Omit to let the router pick. Single mode only — incompatible with " +
        "mode='fanout' (use `models` there).",
    ),
  graceSeconds: z
    .number()
    .int()
    .min(0)
    .max(600)
    .optional()
    .describe(
      `Seconds to wait for the run inline before returning a pollable jobId (default ` +
        `${DEFAULT_GRACE_SECONDS}). 0 returns the jobId immediately (pure async). ` +
        `Raising it past your MCP client's own request timeout buys nothing — the run ` +
        `continues in the background either way and the result stays collectible via ` +
        `\`job_status\`, so a client timeout on this call loses nothing but the inline reply.`,
    ),
} as const;

export const jobStatusInputShape = {
  jobId: z
    .string()
    .regex(JOB_ID_RE, "jobId must look like job-<timestamp>-<8 hex chars>")
    .optional()
    .describe(
      "Check a previously started dispatch: returns partialOutput while running and " +
        "the full result once completed or failed. Omit to list the 20 most recent " +
        "background dispatches instead, with a count of any older ones.",
    ),
} as const;

export const usageInputShape = {
  listModels: z
    .string()
    .optional()
    .describe(
      "Route id of an OpenAI-compatible endpoint (e.g. an entry from `endpoints:` " +
        "like nvidia_nim or ollama). If the route declares a `models:` list in " +
        "config, that operator-curated list is returned as-is — declaring it is " +
        "how you override live discovery (e.g. to pin specific ids, or the " +
        "endpoint's /models listing is noisy/untrustworthy). Otherwise fetches the " +
        "endpoint's live GET /models catalog server-side — the API key never " +
        "leaves the router. Either way, results come back under `liveModels`. CLI " +
        "harness routes don't support this; use their modelHint instead.",
    ),
};

/**
 * `cancel_job` takes the jobId and, optionally, why. The reason is not
 * decoration: a cancelled run's status carries it, so whoever finds the job
 * later — often a different agent — learns it was stopped on purpose rather
 * than that it mysteriously died.
 */
export const cancelJobInputShape = {
  jobId: z
    .string()
    .regex(JOB_ID_RE, "must look like job-<timestamp>-<8 hex chars>")
    .describe("The jobId returned by `dispatch`."),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Why it is being cancelled, recorded on the job so a later reader knows " +
        "it was stopped deliberately (e.g. 'superseded by job-...', 'wrong directory').",
    ),
} as const;

/**
 * `workspace` — inspect or resolve the isolated result of a finished job.
 *
 * One tool with an action rather than three tools, because all three operate
 * on the SAME object (one job's workspace) with the same parameters: three
 * verbs on one noun, with nothing mutually exclusive. Contrast dispatch and
 * job_status, which are separate tools because one covering both "start work"
 * and "check work" needs runtime guards against mutually-exclusive params.
 */
export const workspaceInputShape = {
  jobId: z
    .string()
    .regex(JOB_ID_RE, "must look like job-<timestamp>-<8 hex chars>")
    .describe("A finished job that ran with workspacePolicy 'copy' or 'git_worktree'."),
  action: z
    .enum(["diff", "apply", "discard"])
    .describe(
      "'diff' returns the actual patch of what the agent changed (and writes it to " +
        "the job directory). 'apply' applies that patch to the ORIGINAL project. " +
        "'discard' deletes the isolated workspace, leaving the project untouched.",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Override a refusal. On 'apply': apply even when the target project has " +
        "uncommitted changes (a check only possible IN A GIT REPOSITORY — outside " +
        "one, apply still refuses a file the patch touches that changed since the " +
        "dispatch, but cannot see unrelated edits) — off by default because the " +
        "patch was built against a clean base, so applying over newer work can " +
        "conflict with or overwrite it. " +
        "On 'discard': delete the workspace even when it holds changes your project " +
        "does not have — off by default because discard is irreversible and the " +
        "workspace may be the only copy.",
    ),
} as const;

/** `retry_job` — run a finished job's task again, optionally on another route. */
export const retryJobInputShape = {
  jobId: z
    .string()
    .regex(JOB_ID_RE, "must look like job-<timestamp>-<8 hex chars>")
    .describe("The finished job whose task should be attempted again."),
  service: z
    .string()
    .optional()
    .describe(
      "Route the retry somewhere else (e.g. the original hit its usage limit). " +
        "Omit to reuse the original route, or to let the router pick again if it " +
        "had none. Get valid ids from `usage`. Retargeting leaves behind the " +
        "original's model when the new route does not declare it — a model name " +
        "belongs to the route it was picked for — and reports it as " +
        "`droppedModel`; pass a fresh `hints.model` on `dispatch` to choose one " +
        "for this route.",
    ),
} as const;
