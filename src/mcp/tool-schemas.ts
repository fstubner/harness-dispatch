/**
 * The MCP input contract: what the three tools accept, and what they refuse.
 *
 * Split out of tools.ts, which had grown to 1040 lines mixing the contract
 * with the handlers that run after it. This half earns its own file rather
 * than merely being long: these schemas ARE the safety boundary. The SDK
 * validates arguments against them BEFORE any handler runs, so a key absent
 * here is a key silently stripped — which is exactly how a top-level
 * `safetyProfile` once ran a dispatch with more access than the caller
 * asked for. Being able to read the whole accepted surface, and every
 * deliberate refusal, in one place is the point.
 */

import { z } from "zod";

/**
 * setTimeout's real ceiling. Above it Node emits TimeoutOverflowWarning and
 * CLAMPS TO 1ms, so the longest timeout a caller can ask for becomes the
 * shortest one possible: the child is SIGTERMed on the first tick and the run
 * is recorded as a route failure with breaker credit. `.int()` alone stops at
 * Number.MAX_SAFE_INTEGER, far past the point it breaks.
 *
 * Lives here because this file is the contract; http/parse.ts mirrors it.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A string that ends up in an argv array. A NUL fails deep inside cross-spawn
 * with "The argument 'args[N]' must be a string without null bytes" — the raw
 * Node internal these boundary rejections exist to replace. `prompt` was
 * guarded and the rest were not, on BOTH surfaces, so parity held while both
 * were wrong.
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
      // Blank is not "no preference" — it survived as a value and won the `??`
      // against the route's configured model, so the route ran with no --model
      // flag at all and reported model: "". Nothing said so. Whitespace does
      // the same thing while also reaching the harness as a real argument.
      //
      // BOTH, not just the refine: .min(1) is the only half that reaches the
      // advertised JSON Schema as `minLength: 1`. A refine alone emits a bare
      // {"type":"string"}, so a schema-validating client stops catching "" and
      // spends a round trip on a -32602 — the same "an agent following the
      // schema burns a call" cost this file's `service` wording was fixed for.
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
        "Preferred route or model name (e.g. a route id like 'codex' or a model like " +
          "'gpt-5.6-sol'). Routes that statically declare this model get a scoring " +
          "boost. A value that names a CONFIGURED ROUTE steers routing rather than " +
          "being sent on as a model — a route id is not a model name, and sending one " +
          "cost real provider calls before this was separated. When you ALSO name a " +
          "route with the top-level `service` param, only a value naming THAT " +
          "route is dropped; one that merely collides with a different route's id is a " +
          "real model request and is still passed on. Anything else IS " +
          "passed to the harness as an override, even on a route that doesn't recognize " +
          "it — NOT validated, so an unfamiliar or misspelled name can still fail at " +
          "dispatch time if the harness doesn't support it. Two response fields tell " +
          "you which happened: routing.modelHintDropped: true means it named a route " +
          "and was used for routing only, so the route ran its own default model; " +
          "routing.modelHintMatched: true means the picked route actually declares " +
          "this model, and false means it was forwarded blind and you should treat the " +
          "result with more suspicion (or check why). " +
          "Call the `usage` tool first to see valid route ids, their default models, " +
          "and a modelHint per route pointing to where that harness's real model " +
          "catalog is documented (or how to list it) — use it to pick correctly up " +
          "front or self-correct after an unfamiliar-model failure. In fanout mode " +
          "this field is ignored entirely — use `models` (top-level, not under " +
          "hints) to select fanout candidates instead.",
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
          "cannot honor the requested profile are skipped.",
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
      // setTimeout CLAMPS anything above this to 1ms after emitting
      // TimeoutOverflowWarning, so the longest timeout a caller can ask for
      // becomes the shortest one possible: the child is killed on the first
      // tick and the run is recorded as a route failure. `.int()` alone stops
      // at Number.MAX_SAFE_INTEGER, which is far past the point it breaks.
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
  // STRICT, and this is a safety control, not tidiness.
  //
  // zod drops unknown keys by default. The same setting is spelled
  // `safety_profile` in config.yaml and `safetyProfile` here, so the obvious
  // slip was silently discarded — `hints: { safety_profile: "read_only" }` ran
  // a full_auto route at full_auto, while the correctly-spelled key refused
  // it. A caller asking to be restricted got no restriction and no warning.
  //
  // config.ts already treats this class as a root cause (it warns on ANY
  // unrecognised route key). This is the same fix at the MCP boundary, which
  // PRODUCT.md calls the actual product surface.
  .strict()
  .describe("Public routing hints.");

export const workingDirDescription =
  "Absolute path to the project the task is about. EFFECTIVELY REQUIRED: when omitted, " +
  "the task runs in the router server's own working directory — almost never the " +
  "project you mean. Always pass the caller's project root.";

/** Inline grace window: how long `dispatch` waits for the background run before returning a pollable jobId instead of the full result. */
export const DEFAULT_GRACE_SECONDS = 25;

/**
 * Cap on `files` per dispatch.
 *
 * Not a performance limit — each entry's parent directory becomes an
 * `--add-dir` grant on CLI routes (generic-cli.ts includedDirectories ->
 * {{file_dirs}}), so an unbounded list is an unbounded set of directories
 * handed to a coding agent. 64 is far above any real prompt and low enough
 * that a runaway caller is stopped at the boundary rather than at the CLI.
 */
/** The only jobId shape jobs.ts produces; shared by both tools. */
export const JOB_ID_RE = /^job-\d+-[0-9a-f]{8}$/;

export const MAX_CONTEXT_FILES = 64;

/**
 * Cap on prior jobs referenced by one dispatch.
 *
 * Each one costs a disk read and a slice of the delegate's context window.
 * jobs.ts caps the rendered TEXT as well; this bounds the work done to produce
 * it, so a caller naming hundreds of jobs is stopped at the boundary rather
 * than after the reads.
 */
export const MAX_CONTEXT_JOBS = 16;

/**
 * Keys that mean nothing at the top level, trapped IN THE SCHEMA.
 *
 * `hints` is .strict(), so `hints: { safety_profile: ... }` is rejected — but
 * the OUTER object was still permissive, so moving the same key up one level
 * made it vanish silently instead:
 *
 *   hints.safetyProfile = read_only      -> honoured
 *   TOP-LEVEL safetyProfile = read_only  -> dropped, ran with write access
 *
 * WHY SCHEMA FIELDS AND NOT A GUARD FUNCTION. The MCP SDK validates arguments
 * against this shape in strip mode BEFORE the registered handler runs, so no
 * code inside a handler can ever see a misplaced key — it is already gone. A
 * previous version of this trap was a guard function, and it guarded a path
 * nothing shipped: the registered tools stripped the key silently while only
 * the test-only entry point rejected it. z.never() fields make the SDK's own
 * validation throw the guidance message on every surface that parses this
 * shape, and advertise as {"not":{}} in the tool's JSON schema, so a client
 * reading the schema sees the key as unacceptable rather than merely absent.
 *
 * Full .strict() on the outer object is deliberately NOT used: MCP clients may
 * attach their own fields (_meta and similar) and rejecting those would break
 * legitimate callers. Naming the specific misplaced keys closes the trap
 * without guessing at what else may legitimately arrive.
 */
function misplacedKeyTrap(message: string) {
  return z.never({ error: message }).optional().describe(message);
}

function hintKeyTrap(key: string) {
  return misplacedKeyTrap(
    `${key} belongs inside \`hints\`, not at the top level — e.g. hints: { ${key}: ... }. ` +
      `At the top level it does nothing, which for a safety setting means the dispatch ` +
      `runs with MORE access than you asked for.`,
  );
}

/**
 * A snake_case near-miss at the top level.
 *
 * `hints` is .strict() because `hints: { safety_profile }` silently disabled a
 * safety limit. The OUTER object cannot be strict — the SDK carries `_meta`
 * here and the HTTP surface must tolerate OpenAI's own fields — so the same
 * slip one level up stayed silent on both surfaces, and parity held while both
 * were wrong. A named list, because an unknown top-level key is tolerated by
 * design and a near-miss is not.
 *
 * `where` is per key and not a constant. The first version said "inside
 * `hints`" for all eight, but `workingDir` and `contextJobs` are top-level
 * dispatch parameters — so following the advice produced a SECOND error
 * ("Unrecognized key"). A refusal that confidently points at the wrong landing
 * spot costs the round trip it exists to save.
 */
function snakeCaseTrap(wrong: string, right: string, where: string) {
  return misplacedKeyTrap(
    `${wrong} is not a field — this tool spells it ${right}, ${where}. As written it ` +
      `does nothing, which for a safety setting means the dispatch runs with MORE ` +
      `access than you asked for.`,
  );
}

const IN_HINTS = "inside `hints`";
const TOP_LEVEL = "at the top level";

export const misplacedTopLevelKeys = {
  safety_profile: snakeCaseTrap("safety_profile", "safetyProfile", IN_HINTS),
  route_policy: snakeCaseTrap("route_policy", "routePolicy", IN_HINTS),
  task_type: snakeCaseTrap("task_type", "taskType", IN_HINTS),
  prefer_large_context: snakeCaseTrap("prefer_large_context", "preferLargeContext", IN_HINTS),
  timeout_ms: snakeCaseTrap("timeout_ms", "timeoutMs", IN_HINTS),
  // Accepted in BOTH placements — a real top-level parameter as well as a
  // hint, with the top-level value winning when both are given.
  workspace_policy: snakeCaseTrap(
    "workspace_policy",
    "workspacePolicy",
    `${TOP_LEVEL} or ${IN_HINTS}`,
  ),
  working_dir: snakeCaseTrap("working_dir", "workingDir", TOP_LEVEL),
  context_jobs: snakeCaseTrap("context_jobs", "contextJobs", TOP_LEVEL),
  safetyProfile: hintKeyTrap("safetyProfile"),
  routePolicy: hintKeyTrap("routePolicy"),
  taskType: hintKeyTrap("taskType"),
  preferLargeContext: hintKeyTrap("preferLargeContext"),
  timeoutMs: hintKeyTrap("timeoutMs"),
  model: misplacedKeyTrap(
    "model belongs inside `hints` for single mode — hints: { model: ... }. " +
      "In fanout mode use the top-level `models` array instead. At the top " +
      "level it does nothing.",
  ),
  escalate: misplacedKeyTrap(
    "escalate is not a dispatch field — escalation is configured per route in " +
      "config.yaml (escalate_model / escalate_on), not per call.",
  ),
};

export const dispatchInputShape = {
  prompt: z
    .string()
    // Rejected here rather than at the harness. An empty prompt used to reach
    // a real CLI, which spawned, failed with its own usage message, and left a
    // consumed route call behind — a wasted dispatch for something the schema
    // can refuse for free.
    .min(1, "prompt must not be empty")
    // Whitespace is empty for this purpose, and the HTTP surface has always
    // said so (`!prompt.trim()` → 400). Here it passed .min(1) and spent a
    // real route call producing nothing — the exact waste the line above
    // exists to prevent, on the one field that is required.
    .refine((v) => v === "" || v.trim() !== "", "prompt must not be empty")
    // A NUL byte passed the schema and failed deep inside cross-spawn with
    // "The argument 'args[2]' must be a string without null bytes" — caught,
    // never a crash, and correctly not charged to the route's failure count,
    // but a raw Node internal message where a boundary rejection belongs.
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
        `${MAX_CONTEXT_FILES}). A path outside workingDir is still sent, but ` +
        `for CLI routes its PARENT DIRECTORY is also granted to the agent via ` +
        `--add-dir, so it escapes an isolated workspace — the response carries ` +
        `a warning naming the directories when that happens.`,
    ),
  workingDir: z.string().optional().describe(workingDirDescription),
  workspacePolicy: workspacePolicySchema.optional().describe("Workspace execution policy."),
  hints: publicHintsSchema.optional(),
  ...misplacedTopLevelKeys,
  models: z
    .array(z.string().refine(noNul, NO_NUL_MESSAGE))
    // An EXPLICIT empty array is a caller mistake, and the most expensive one
    // this field can carry: it fell through to the same branch as "omitted"
    // and fanned out to every eligible route — measured at eight arms on one
    // machine, one per configured route. A caller who wrote `models: []` built
    // a list and it came out empty; they did not ask for everything. Omitting
    // the field is how you ask for that, and it stays a deliberate keystroke
    // rather than the result of a filter matching nothing.
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
      "Optional explicit route id to run (e.g. 'codex', 'cursor', 'local_inference' — " +
        "see the `usage` tool for valid ids). Omit to let the router pick. Single " +
        "mode only — incompatible with mode='fanout' (use `models` there).",
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
        "the full result once completed or failed. Omit to list every known background " +
        "dispatch instead.",
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
 * `cancel_job` takes the jobId and, optionally, why.
 *
 * The reason is not decoration: a cancelled run's status carries it, so
 * whoever finds the job later — often a different agent, or the same one
 * after a restart — learns it was stopped on purpose rather than that it
 * mysteriously died.
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
 * on the SAME object (one job's workspace) with the same parameters. That is
 * the opposite of the dispatch/job_status split, where one tool covering both
 * "start work" and "check work" needed runtime guards against
 * mutually-exclusive params — a sign the boundary was wrong. Here the actions
 * are three verbs on one noun, and nothing is mutually exclusive.
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
