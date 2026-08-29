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

/** The message both surfaces give, so the advice cannot drift either. */
export function nearMissMessage(key: string, meant: string): string {
  return (
    `${key} is not a field — did you mean ${meant}? It would otherwise be accepted ` +
    `and silently ignored, which for a safety setting means the dispatch runs with ` +
    `MORE access than you asked for.`
  );
}
