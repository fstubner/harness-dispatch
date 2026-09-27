/**
 * Operator instructions: free text from config.yaml that the MCP server hands
 * every connecting agent, once globally (`instructions:` at the top level) and
 * once per route (`instructions:` on a `clis:`/`endpoints:`/`overrides:`
 * entry). It is how a machine's routing policy — which model tier for which
 * kind of task, which route to prefer — is written once instead of in every
 * client's own instruction file.
 *
 * Capped, because every connecting session pays for this text in its context
 * on every turn, and a pasted document would crowd out the work it guides.
 */
export const MAX_INSTRUCTIONS_CHARS = 1000;

/** The usable text of an `instructions:` value, or undefined when there is none. */
export function instructionsFrom(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return undefined;
  return text.length <= MAX_INSTRUCTIONS_CHARS ? text : text.slice(0, MAX_INSTRUCTIONS_CHARS);
}

/**
 * Warn about an `instructions:` value that will not be delivered as written:
 * not text at all (dropped), or longer than the cap (cut).
 */
export function warnInstructions(raw: unknown, label: string, warnings: string[]): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "string") {
    warnings.push(
      `${label}: instructions must be text, not ${Array.isArray(raw) ? "a list" : typeof raw} — IGNORED, ` +
        `so connecting agents are not told it.`,
    );
    return;
  }
  const length = raw.trim().length;
  if (length > MAX_INSTRUCTIONS_CHARS) {
    warnings.push(
      `${label}: instructions are ${length} characters; only the first ${MAX_INSTRUCTIONS_CHARS} ` +
        `are sent to connecting agents. Every session carries this text in its context, so keep it short.`,
    );
  }
}
