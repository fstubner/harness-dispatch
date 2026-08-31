/**
 * "Did you mean…" for a top-level key that is one typo from a hint name.
 *
 * WHY THIS EXISTS. Neither surface's outer object can be strict — MCP carries
 * `_meta`, and the HTTP surface must tolerate OpenAI's own fields — so an
 * unknown top-level key was accepted and dropped on both. The named traps in
 * mcp/tool-schemas.ts and http/parse.ts catch the snake_case spellings, which
 * are the predictable slip. A plain typo is not enumerable and had the same
 * consequence: `safteyProfile` returned success and the dispatch ran at the
 * default `workspace_edit` — more access than the caller asked for, with no
 * signal — while the correct spelling produced `read_only`.
 *
 * ONE COPY ON PURPOSE. This file exists because the alternative is the same
 * rule written twice, and tool-schemas.ts already records where that leads:
 * "Three independent copies of one rule is how they diverged". The surfaces
 * disagreeing about which keys are typos would be exactly the "same input, two
 * answers" class the parity suite was built to end.
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
 * adjacent characters.
 *
 * The swap is not an extra. `safteyProfile` is the exact spelling an acceptance
 * pass typed, and plain edit distance scores a transposition as TWO
 * substitutions — so a rule without it misses the case it was written for.
 *
 * Deliberately tight in the other direction too: at a true distance of two,
 * short field names from the OpenAI protocol start matching, and refusing a
 * legitimate request would be its own defect.
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
 * traps there and belong inside `hints`. The HTTP surface reads ALL SEVEN from
 * the top level of the request body (`http/parse.ts`), which is why the advice
 * below has to know which surface is asking.
 */
const MCP_TOP_LEVEL_NAMES = new Set(["workingDir", "workspacePolicy"]);

export type NearMissSurface = "mcp" | "http";

/**
 * The message both surfaces give — same RULE, correct advice for each.
 *
 * The rule is shared on purpose (see this file's header). The advice cannot
 * be: a single "did you mean X?" sent the caller somewhere the surface would
 * refuse or ignore, which is the failure `tool-schemas.ts` already records
 * from its own snake_case traps — "a refusal that confidently points at the
 * wrong landing spot costs the round trip it exists to save". An acceptance
 * pass measured the new message repeating it: correcting `safteyProfile` to
 * `safetyProfile` on MCP `dispatch` produced a SECOND rejection, because the
 * corrected spelling is a trap at that level.
 *
 * `toolName` is MCP-only and names the tool the call was for. On a tool that
 * takes no hints at all — `job_status`, `usage`, `cancel_job`, `retry_job`,
 * `workspace` — the corrected spelling is simply not a field, and the old
 * message's "the dispatch runs with MORE access than you asked for" was false
 * on every one of them: none of them dispatch anything.
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
