/**
 * One place that knows every secret this process holds, and one function that
 * removes them from anything on its way out.
 *
 * WHY THIS EXISTS, because the alternative was tried six times and failed six
 * times. The same defect — a configured credential reaching a caller, a log
 * file or an agent's context — was found and "fixed" in six consecutive
 * rounds. Every fix was correct. Every fix was also incomplete, because each
 * one scrubbed at a SITE: a specific error path in a specific file. Four of
 * the six were found as "the fix landed in one branch and the sibling beside
 * it kept leaking", twice inside a single file. One round shipped a comment
 * asserting that every branch was covered while a branch was not.
 *
 * Sites are the wrong unit. There is no bounded list of places a string can be
 * built, and a new one is added by ordinary feature work with no reason for
 * its author to think about credentials. What IS bounded is the set of ways a
 * string leaves this process: it is serialized to JSON for a tool result or an
 * HTTP response, appended to the dispatch log, written into a job file, or
 * printed to the terminal. Those are sinks, there are few of them, and they
 * change rarely.
 *
 * So: scrub at the sinks, and derive the secrets from the loaded config rather
 * than naming them per call site. A leak then requires someone to add a whole
 * new egress mechanism, not merely to write a new error message.
 *
 * This is deliberately more machinery than the individual fixes it replaces.
 * It has earned that: it is not guarding against a hypothetical, it is
 * guarding against six measured, reproduced disclosures, one of which put a
 * key into a file on disk and another into an orchestrating agent's context.
 */

import type { RouterConfig } from "./types.js";

/** What a removed secret is replaced with. Matches `scrubEndpointSecrets`. */
export const REDACTED = "<redacted>";

/**
 * Below this length a "secret" is more likely to be a coincidence than a
 * credential, and redacting it would corrupt ordinary output.
 *
 * A real key is far longer. The risk being traded here is asymmetric and worth
 * stating: too low a bound mangles legitimate text (a route named `a` would
 * turn every `a` in an answer into a placeholder), while too high a bound
 * misses a short key. Eight is below every provider key format in this
 * project's own config and far above the length at which a value collides with
 * prose by accident.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * A URL path segment at least this long is treated as a credential.
 *
 * Some providers put the token in the path (`/bot<TOKEN>/sendMessage`), and a
 * path segment cannot be told apart from a credential by inspection — which is
 * why `redactEndpointHost` preserves the path and a verification pass measured
 * a key leaking through it. Length is the one signal available: the documented
 * path components in this project's config are `v1`, `v1beta`, `openai`, `api`
 * and `gw`, none close to this bound.
 *
 * A false positive costs one redacted word in a diagnostic message. A false
 * negative costs a credential. This only affects text on its way out — never a
 * request that is actually sent — so the failure is always the cheap one.
 */
const CREDENTIAL_PATH_SEGMENT_LENGTH = 16;

/**
 * Every secret value reachable from a loaded config.
 *
 * `envRefs` is the richest source and the reason this can be thorough rather
 * than a list of fields someone remembered: it is keyed by the RESOLVED value
 * of every `${VAR}` in the config file, so it holds interpolated credentials
 * regardless of which key they were written under — including the top-level
 * `api_keys:` block, whose entries are keyed by ROUTE NAME and therefore match
 * no credential-looking key name at all. A pass measured every entry after the
 * first in that block leaking, precisely because the earlier fix matched key
 * names.
 *
 * Literal (non-`${VAR}`) values are not in `envRefs`, so per-route fields are
 * collected too.
 */
export function collectSecrets(config: RouterConfig | undefined): string[] {
  const out = new Set<string>();
  if (!config) return [];

  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) out.add(trimmed);
  };

  for (const resolved of config.envRefs?.keys() ?? []) add(resolved);

  for (const svc of Object.values(config.services ?? {})) {
    add(svc.apiKey);
    if (svc.baseUrl === undefined) continue;
    try {
      const url = new URL(svc.baseUrl);
      add(url.password);
      add(url.username);
      for (const value of url.searchParams.values()) add(value);
      for (const segment of url.pathname.split("/")) {
        if (segment.length >= CREDENTIAL_PATH_SEGMENT_LENGTH) add(segment);
      }
    } catch {
      // An unparseable base_url has no parts to take apart. Any credential
      // written into it is still caught if it also appears as an api_key or a
      // ${VAR}, which is how it is normally configured.
    }
  }

  // Longest first, so a secret that contains another is removed whole rather
  // than being left as a recognisable fragment around a placeholder.
  return [...out].sort((a, b) => b.length - a.length);
}

/** Remove every one of `secrets` from `text`, by value. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * The secrets of the config this process is currently running.
 *
 * Process-wide mutable state, which is normally a smell and is the right shape
 * here: whether a given string is a credential is a property of the process,
 * not of the call. Threading config into the dispatch log, the JSON
 * serializers and the job-file writers is exactly the per-site plumbing whose
 * absence caused six rounds of this bug — every one of those sinks would have
 * needed a caller to remember to pass it.
 */
let activeSecrets: readonly string[] = [];

/**
 * Secrets seen while PARSING a config, which never become a route field.
 *
 * The top-level `api_keys:` block is the case that forced this. Its entries
 * are applied to routes by name, so an entry whose route also declares an
 * inline `api_key:` — or that names no route at all — is a live credential
 * sitting in the config file that `collectSecrets` cannot see from the
 * finished RouterConfig. A pass measured every entry after the first in that
 * block leaking, and this is the machine setup this project documents.
 *
 * Accumulated rather than replaced on reload, deliberately: continuing to
 * scrub a credential that has been removed from the config costs one
 * unnecessary replacement in output that would not have contained it anyway,
 * whereas forgetting one costs a disclosure.
 */
const parsedSecrets = new Set<string>();

/** Record a secret found while parsing, for redaction to pick up. */
export function registerSecretValue(value: string | undefined): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed.length >= MIN_SECRET_LENGTH) parsedSecrets.add(trimmed);
}

/** Install the secrets for a loaded config. Safe to call on every reload. */
export function setActiveSecrets(config: RouterConfig | undefined): void {
  const merged = new Set([...collectSecrets(config), ...parsedSecrets]);
  activeSecrets = [...merged].sort((a, b) => b.length - a.length);
}

/** For tests that need to restore a clean slate. */
export function clearActiveSecrets(): void {
  activeSecrets = [];
  parsedSecrets.clear();
}

/** How many secrets are currently registered. For diagnostics and tests. */
export function activeSecretCount(): number {
  return activeSecrets.length;
}

/**
 * Remove every registered secret from text that is about to leave the process.
 *
 * Call this at SINKS — serialization, disk writes, terminal output — not at
 * the places strings are built. That distinction is the whole design.
 */
export function redact(text: string): string {
  if (activeSecrets.length === 0) return text;
  return scrubSecrets(text, activeSecrets);
}

/**
 * Redact everything written to stdout and stderr, for the life of the process.
 *
 * The terminal is a sink like any other, and it was the one left unwired when
 * the JSON and disk sinks were done — measured immediately afterwards, with a
 * path-embedded credential surviving into `status --json`, `usage` and
 * `configure --print` while the same value was correctly removed from the MCP
 * and HTTP payloads. That is the per-site failure this whole design exists to
 * end, reproduced one more time by doing four sinks out of five.
 *
 * Installed once at the entrypoint rather than applied at each print, because
 * `bin.ts` alone writes to stdout from dozens of places and every future
 * command adds more. `redact` reads the registry at call time, so installing
 * before config load is correct: writes made before any secret is known are
 * unchanged, and everything after is covered with no ordering requirement.
 *
 * Non-string chunks pass through untouched — a Buffer write is not text this
 * process composed, and decoding one to scan it would risk corrupting binary
 * output for no benefit.
 */
export function installOutputRedaction(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.write = ((chunk: any, ...rest: any[]): boolean => {
      if (typeof chunk === "string" && activeSecrets.length > 0) {
        return original(redact(chunk), ...(rest as []));
      }
      return original(chunk, ...(rest as []));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  }
}
