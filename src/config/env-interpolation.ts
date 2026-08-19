/**
 * `${VAR}` interpolation over a loaded config tree.
 *
 * Split out of config.ts. Small, but it carries two invariants worth keeping
 * together and away from the parsing code:
 *
 * 1. It records every substitution it makes (`refs`), mapping the RESOLVED
 *    value back to the reference that produced it. That map is what lets
 *    `configure` write `${GROQ_API_KEY}` back out instead of the live secret
 *    it resolved to — without it, regenerating a config leaks credentials into
 *    a file people paste into bug reports.
 * 2. It records references whose variable is unset (`unsetVars`), because the
 *    result is an empty string that otherwise looks exactly like "not
 *    configured" — a route silently losing its api_key and reporting ready.
 */

export const ENV_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Every ${VAR} occurrence, not only a whole-string match. */
const ENV_VAR_ANYWHERE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * `unsetVars` collects the names of ${VAR} references that resolved to
 * nothing because the env var isn't set at all — distinct from a var
 * deliberately set to "". Without this, a typo'd or forgotten env var
 * (${ANTHROPIC_API_KEY} when the real name is ${ANTHROPIC_KEY}) silently
 * becomes an empty string: `str()` then drops the field entirely, a route
 * that needed an api_key loses it with zero feedback, and doctor reports
 * the route "ready" right up until the first real call 401s.
 *
 * Replacement applies ANYWHERE in the string, matching what the shipped
 * config's comment has promised all along ("anywhere in a string value").
 * The implementation was anchored to whole-string matches, so
 * `base_url: https://${HOST}/v1` stayed a literal, got no unset-var warning
 * (unsetVars only tracked whole-string matches), and failed downstream with
 * an error about a URL containing a dollar sign.
 */
export function interpolateEnv(
  value: string,
  unsetVars: Set<string>,
  refs: Map<string, string>,
): string {
  if (!value.includes("${")) return value;
  const resolved = value.replace(ENV_VAR_ANYWHERE_RE, (_match, name: string) => {
    if (!(name in process.env)) unsetVars.add(name);
    return process.env[name] ?? "";
  });
  if (resolved === value) return value; // nothing legal to substitute
  // Remember which reference produced this value so `configure` can emit the
  // ${VAR} template back instead of the secret it resolved to. Keyed by
  // resolved value rather than by config path because interpolation runs over
  // the raw tree before any of it is shaped into routes. Two variables holding
  // the same secret collide, but harmlessly: either reference resolves to that
  // same value, so emitting either is correct. Empty resolutions are skipped —
  // they carry no secret and would collide with every other unset var.
  if (resolved !== "") refs.set(resolved, value);
  return resolved;
}

/** Walk an object tree and replace any "${VAR}" string leaves with env values. */
export function interpolateTree<T>(node: T, unsetVars: Set<string>, refs: Map<string, string>): T {
  if (typeof node === "string") {
    return interpolateEnv(node, unsetVars, refs) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map((v) => interpolateTree(v, unsetVars, refs)) as unknown as T;
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = interpolateTree(v, unsetVars, refs);
    }
    return out as unknown as T;
  }
  return node;
}
