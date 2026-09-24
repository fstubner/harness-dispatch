/**
 * "Did you mean…" for a top-level key that is one typo from a hint name.
 *
 * Neither surface's outer object can be strict — MCP carries `_meta`, and the
 * HTTP surface must tolerate OpenAI's own fields — so an unknown top-level key
 * is accepted and dropped on both. The named traps in mcp/tool-schemas.ts and
 * http/parse.ts catch the predictable snake_case spellings; a plain typo is
 * not enumerable and has the same consequence: `safteyProfile` returns success
 * and the dispatch runs at the default `workspace_edit`, more access than the
 * caller asked for, while the correct spelling produces `read_only`.
 *
 * ONE COPY ON PURPOSE: the surfaces disagreeing about which keys are typos is
 * the "same input, two answers" class the parity suite exists to prevent.
 */

/** The hint names a caller can plausibly mistype at the top level. */
export const HINT_KEY_NAMES = [
  "safetyProfile",
  "routePolicy",
  "taskType",
  "workspacePolicy",
  "preferLargeContext",
  "timeoutMs",
  "workingDir",
] as const;

/**
 * The hint name this key is one typo away from, or undefined.
 *
 * Returns undefined for an exact match: that is a correct key, not a near miss.
 */
export function nearMissHintKey(key: string): string | undefined {
  if ((HINT_KEY_NAMES as readonly string[]).includes(key)) return undefined;
  return HINT_KEY_NAMES.find((known) => withinOneTypo(key, known));
}

/**
 * One typo apart: an insertion, deletion, substitution, or a swap of two
 * adjacent characters. The swap is not an extra — plain edit distance scores a
 * transposition as TWO substitutions, so a rule without it misses
 * `safteyProfile`.
 *
 * Tight in the other direction too: at a true distance of two, short OpenAI
 * protocol field names start matching, and refusing a legitimate request would
 * be its own defect.
 */
export function withinOneTypo(a: string, b: string): boolean {
  if (a === b) return false;
  if (isAdjacentSwap(a, b)) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (short.length === long.length) i += 1;
    j += 1;
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

/** Two adjacent characters swapped, and otherwise identical. */
function isAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) diff.push(i);
    if (diff.length > 2) return false;
  }
  if (diff.length !== 2) return false;
  const [x, y] = diff as [number, number];
  return y === x + 1 && a[x] === b[y] && a[y] === b[x];
}

/**
 * Where each hint name legitimately goes on the MCP surface.
 *
 * Only these two are top-level `dispatch` parameters; the rest are `z.never()`
 * traps there and belong inside `hints`. The HTTP surface reads all seven from
 * the top level (`http/parse.ts`), so the advice below has to know which
 * surface is asking.
 */
const MCP_TOP_LEVEL_NAMES = new Set(["workingDir", "workspacePolicy"]);

export type NearMissSurface = "mcp" | "http";

/**
 * The message both surfaces give — same RULE, correct advice for each.
 *
 * The rule is shared (see this file's header); the advice cannot be. A single
 * "did you mean X?" sends the caller somewhere the surface would refuse: on
 * MCP `dispatch`, correcting `safteyProfile` to `safetyProfile` at the top
 * level earns a SECOND rejection, because that spelling is a trap at that
 * level.
 *
 * `toolName` is MCP-only. On a tool that takes no hints at all — `job_status`,
 * `usage`, `cancel_job`, `retry_job`, `workspace` — the corrected spelling is
 * not a field either, and none of them dispatch anything, so the safety
 * warning does not apply.
 */
export function nearMissMessage(
  key: string,
  meant: string,
  opts: { surface: NearMissSurface; toolName?: string } = { surface: "http" },
): string {
  const head = `${key} is not a field — did you mean ${meant}?`;
  const ignored = "As written it is accepted and silently ignored";
  const safetyTail =
    ", which for a safety setting means the run gets MORE access than you asked for.";

  if (opts.surface === "mcp" && opts.toolName !== undefined && opts.toolName !== "dispatch") {
    return (
      `${head} Neither spelling is a field on \`${opts.toolName}\` — hints apply to ` +
      `\`dispatch\`. ${ignored}.`
    );
  }
  const where =
    opts.surface === "mcp" && !MCP_TOP_LEVEL_NAMES.has(meant)
      ? `On this surface it goes inside \`hints\` — hints: { ${meant}: ... }.`
      : `It belongs at the top level of the request.`;
  return `${head} ${where} ${ignored}${safetyTail}`;
}
