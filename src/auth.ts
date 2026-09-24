import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { dirFromEnv, stateRoot } from "./state-dir.js";

const TOKEN_ENV = "HARNESS_DISPATCH_HTTP_TOKEN";

export function authDir(): string {
  return dirFromEnv("HARNESS_DISPATCH_HOME", stateRoot);
}

export function tokenPath(): string {
  return path.join(authDir(), "http-token");
}

export function generateHttpToken(): string {
  return `hr_${randomBytes(32).toString("base64url")}`;
}

export async function readHttpToken(): Promise<string | null> {
  const fromEnv = process.env[TOKEN_ENV];
  if (fromEnv) return fromEnv;
  try {
    const token = (await fs.readFile(tokenPath(), "utf-8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * The token as it is on disk RIGHT NOW, for a running server to consult.
 *
 * A server that read the token once at startup and held it forever makes `auth
 * rotate` a lie in both directions: the old token keeps returning 200 and the
 * newly issued one is rejected with 401.
 *
 * Synchronous because it is consulted on the authorization path of every
 * request, which is not async. The file is a few dozen bytes on local disk and
 * the read is guarded by an mtime check in the caller.
 */
export function readHttpTokenSync(): string | null {
  const fromEnv = process.env[TOKEN_ENV];
  if (fromEnv) return fromEnv;
  try {
    const token = readFileSync(tokenPath(), "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/** Modification time of the token file, or 0 when there isn't one. */
export function httpTokenMtimeMs(): number {
  try {
    return statSync(tokenPath()).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Write the token, and make sure both it and its directory are owner-only.
 *
 * Two POSIX hazards, on the directory and on the file:
 *
 * 1. `ensureHttpToken` runs at server startup, so on a fresh install this is
 *    the realistic first creator of the state root. Without an explicit
 *    `mode`, that root is 0755 at the default umask and 0777 at umask 000 —
 *    writable by another user, who can plant a `config.yaml` there. That path
 *    is live and read last by config lookup, so a planted file steers routes
 *    and credential references.
 *
 * 2. `mode:` on a write applies only when the file is CREATED, so rotating
 *    over an existing 0644 token leaves it 0644 — and `auth rotate` is the
 *    command you run BECAUSE the token leaked. Only an explicit chmod changes
 *    it.
 *
 * chmod is best-effort: a no-op on Windows, and a token written successfully
 * should not fail the command because its mode could not be tightened.
 */
async function writeTokenFile(token: string): Promise<void> {
  const dir = authDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath(), `${token}\n`, { mode: 0o600 });
  if (process.platform === "win32") return;
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.chmod(tokenPath(), 0o600).catch(() => undefined);
}

export async function ensureHttpToken(): Promise<string> {
  const existing = await readHttpToken();
  if (existing) return existing;
  const token = generateHttpToken();
  await writeTokenFile(token);
  return token;
}

export async function rotateHttpToken(): Promise<string> {
  // The environment variable wins over the file everywhere the token is read,
  // so rotating the file while it is set changes nothing: the printed token is
  // refused and the old one — the one being rotated because it leaked — keeps
  // working. Refusing is the only honest answer, since this process cannot
  // change the environment of a server already running.
  if (process.env[TOKEN_ENV]) {
    throw new Error(
      `auth rotate: the token in use comes from ${TOKEN_ENV}, so rotating the token ` +
        `file would change nothing — the current token would keep working. Put a new ` +
        `value in ${TOKEN_ENV} (or unset it to use the file) and restart serve.`,
    );
  }
  const token = generateHttpToken();
  await writeTokenFile(token);
  return token;
}

/**
 * Constant-time string compare. `value === expected` short-circuits on the
 * first mismatching byte — a textbook timing side channel for guessing a
 * bearer token one byte at a time.
 *
 * On a length mismatch it still does comparison work rather than returning
 * early, sized by `expected` and not by `value` — comparing the
 * caller-supplied buffer against itself would scale the cost with the length
 * an attacker chose. Sized this way, the remaining signal is the same for
 * every wrong length.
 */
function safeEqual(value: string, expected: string): boolean {
  const valueBuf = Buffer.from(value, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (valueBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(valueBuf, expectedBuf);
}

/**
 * Whether a request carries the expected bearer token.
 *
 * A `token` of null means NO AUTH IS CONFIGURED, and every request is
 * authorized — this function fails open, deliberately, and a caller that
 * cannot guarantee a token must not rely on it to deny anything. The HTTP
 * server can: it calls `ensureHttpToken()` at startup and falls back to the
 * token it read from disk on refresh, so null never reaches here from there.
 */
export function isAuthorized(
  authorizationHeader: string | string[] | undefined,
  token: string | null,
): boolean {
  if (token === null) return true;
  const value = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (value === undefined) return false;
  return safeEqual(value, `Bearer ${token}`);
}

export function maskToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}
