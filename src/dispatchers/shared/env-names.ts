/**
 * Environment variable names, compared the way the platform compares them.
 *
 * On Windows `GROQ_API_KEY` and `groq_api_key` are the same variable: Node's
 * `process.env` answers either. But a plain object copy of it is
 * case-sensitive, so blanking `groq_api_key` over a copy that holds
 * `GROQ_API_KEY` adds a second entry rather than clearing the first, and the
 * child is handed the key anyway. A config can legitimately spell a reference
 * in any case there, so every comparison and merge that decides what a
 * delegate may see has to fold case on win32.
 */

/** Do two names refer to the same variable on `platform`? */
export function sameEnvName(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * `base` with `overrides` applied. On win32 an override replaces an existing
 * entry whose name differs only in case, instead of sitting beside it.
 */
export function mergeEnv(
  base: Record<string, string | undefined>,
  overrides: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const merged = { ...base };
  if (platform === "win32") {
    const folded = new Set(Object.keys(overrides).map((k) => k.toLowerCase()));
    for (const key of Object.keys(merged)) {
      if (folded.has(key.toLowerCase())) delete merged[key];
    }
  }
  return Object.assign(merged, overrides);
}
