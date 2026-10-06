/**
 * One place that knows every secret this process holds, and one function that
 * removes them from anything on its way out.
 *
 * WHY SINKS RATHER THAN SITES. Scrubbing a credential where the string is
 * BUILT — a specific error path in a specific file — cannot hold: there is no
 * bounded list of such places, and a new one is added by ordinary feature work
 * with no reason for its author to think about credentials. What IS bounded is
 * the set of ways a string leaves this process: serialized to JSON for a tool
 * result or an HTTP response, appended to the dispatch log, written into a job
 * file, or printed to the terminal. Those are few, and they change rarely.
 *
 * So: scrub at the sinks, and derive the secrets from the loaded config rather
 * than naming them per call site. A leak then requires someone to add a whole
 * new egress mechanism, not merely to write a new error message.
 */

import type { RouterConfig } from "./types.js";

/** What a removed secret is replaced with. Matches `scrubEndpointSecrets`. */
export const REDACTED = "<redacted>";

/**
 * Below this length a "secret" is more likely to be a coincidence than a
 * credential, and redacting it would corrupt ordinary output: a route named
 * `a` would turn every `a` in an answer into a placeholder. Eight is below
 * every provider key format in this project's own config and far above the
 * length at which a value collides with prose by accident.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Query keys whose VALUE is a credential.
 *
 * A name test, not a length test: a length rule over URL path segments makes
 * an Azure deployment name (`.../deployments/gpt-4-turbo-preview`) a redaction
 * target. A credential in the path is a real shape, but it cannot be told from
 * a deployment name by inspection, and guessing wrong corrupts output.
 * `warnCredentialInUrlPath` in config.ts says so out loud instead, which is
 * actionable where a silent guess is not.
 */
const CREDENTIAL_QUERY_KEY = /^(api[_-]?key|key|token|access[_-]?token|auth|password|secret|sig|signature)$/i;

/**
 * Every secret value reachable from a loaded config.
 *
 * Collected from fields that HOLD credentials, and deliberately not from
 * `envRefs`, which records every `${VAR}` in the file by resolved value:
 * `${VAR}` is legal in any string value, so `model: ${MY_MODEL}` or
 * `command: ${CODEX_BIN}` would turn a model name and a file path into
 * process-wide redaction targets, silently mangling any answer that mentions
 * them — a corrupted answer being wrong work product delivered as if it were
 * right. A `${VAR}` in a credential field still resolves into `apiKey` before
 * this runs, so nothing real is lost.
 */
export function collectSecrets(config: RouterConfig | undefined): string[] {
  const out = new Set<string>();
  if (!config) return [];

  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) out.add(trimmed);
  };

  for (const svc of Object.values(config.services ?? {})) {
    add(svc.apiKey);
    if (svc.baseUrl === undefined) continue;
    try {
      const url = new URL(svc.baseUrl);
      add(url.password);
      add(url.username);
      // Only query values under a credential-looking KEY. A query string
      // carries ordinary parameters too, and taking every value would make
      // `?model=gemini-2.5-flash` a redaction target for that model name.
      for (const [key, value] of url.searchParams.entries()) {
        if (CREDENTIAL_QUERY_KEY.test(key)) add(value);
      }
    } catch {
      // An unparseable base_url has no parts to take apart. A credential
      // written into one is still caught if it also appears as an api_key,
      // which is how it is normally configured.
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
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    // Redaction runs AFTER JSON.stringify at most sinks, so a secret holding a
    // character JSON escapes — a quote, or the backslashes in a Windows path —
    // is no longer present in its raw form and would otherwise survive.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && out.includes(escaped)) {
      out = out.split(escaped).join(REDACTED);
    }
  }
  return out;
}

/**
 * The secrets of the config this process is currently running.
 *
 * Process-wide mutable state, which is normally a smell and is the right shape
 * here: whether a given string is a credential is a property of the process,
 * not of the call. Threading config into the dispatch log, the JSON
 * serializers and the job-file writers would make every one of those sinks
 * depend on a caller remembering to pass it.
 */
let activeSecrets: readonly string[] = [];

/**
 * Secrets seen while PARSING a config, which never become a route field.
 *
 * The top-level `api_keys:` block forces this: its entries are applied to
 * routes by name, so an entry whose route also declares an inline `api_key:`
 * — or that names no route at all — is a live credential in the config file
 * that `collectSecrets` cannot see from the finished RouterConfig.
 *
 * Accumulated rather than replaced on reload: still scrubbing a credential
 * that has been removed from the config costs one needless replacement,
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
 * The length of the longest suffix of `text` that is a proper prefix of a
 * form `scrubSecrets` removes — the raw secret or its JSON-escaped form, kept
 * in step with that function. 0 when the text cannot end partway into one.
 *
 * Proper prefix only: `text` has already been scrubbed, so a whole form is
 * not in it, and a suffix equal to one would be a secret already complete.
 */
function heldSecretPrefixLength(text: string): number {
  let keep = 0;
  for (const secret of activeSecrets) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    for (const form of escaped === secret ? [secret] : [secret, escaped]) {
      // Scan from the earliest start that could still be a proper prefix, so
      // the first match is the longest one for this form. Only starts that
      // would hold MORE than already found are worth testing.
      for (let i = Math.max(0, text.length - (form.length - 1)); i < text.length - keep; i++) {
        if (text.charCodeAt(i) === form.charCodeAt(0) && form.startsWith(text.slice(i))) {
          keep = text.length - i;
          break;
        }
      }
    }
  }
  return keep;
}

/**
 * `redact` for a sink written chunk by chunk, where a secret can arrive split
 * across two writes.
 *
 * Scrubbing each chunk alone misses a key whose first half ends one chunk and
 * second half starts the next — both halves land in the file and together they
 * are the key (audit5 F8: the one state file holding a full fake key was
 * `stdout.partial.log`). So each push scrubs what is held plus the new chunk,
 * and holds back only the longest suffix that could still be the START of a
 * secret: a suffix that is a proper prefix of some form `scrubSecrets` removes
 * (the raw value, or its JSON-escaped form). An incomplete secret is exactly
 * such a suffix, so it stays held until a later push completes it — and it is
 * scrubbed — or shows it was not one. Everything before it is released at
 * once.
 *
 * Why not a fixed tail. Holding the last (longest secret − 1) characters
 * regardless of content kept every short line in the buffer until the next
 * chunk pushed it out: with one 38-character key configured, a dispatch
 * printing a line every 2 s produced zero progress notifications in 9.4 s.
 * Ordinary output almost never ends in the first characters of a key, so
 * matching holds nothing in practice. `flush` releases what is held.
 */
export function createStreamRedactor(): { push(chunk: string): string; flush(): string } {
  let held = "";
  return {
    push(chunk: string): string {
      const text = redact(held + chunk);
      const keep = heldSecretPrefixLength(text);
      held = text.slice(text.length - keep);
      return text.slice(0, text.length - keep);
    },
    flush(): string {
      const out = redact(held);
      held = "";
      return out;
    },
  };
}

/**
 * Redact everything written to stdout and stderr, for the life of the process.
 *
 * The terminal is a sink like any other: without this, a path-embedded
 * credential survives into `status --json`, `usage` and `configure --print`
 * while the same value is correctly removed from the MCP and HTTP payloads.
 *
 * Installed once at the entrypoint rather than applied at each print, because
 * `bin.ts` alone writes to stdout from dozens of places. `redact` reads the
 * registry at call time, so installing before config load is correct: writes
 * made before any secret is known are unchanged, and everything after is
 * covered with no ordering requirement.
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
