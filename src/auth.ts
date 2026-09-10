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
 * A server read the token once at startup and held it forever, so `auth
 * rotate` was a lie in both directions: an acceptance pass measured the old
 * token still returning 200 after rotation, and the newly issued one being
 * rejected with 401. Invalidating the old token is the entire reason anyone
 * rotates a credential, so telling the user it rotated while the leaked value
 * kept working is the worst possible outcome.
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
 * Two POSIX defects, both measured in a container by an audit:
 *
 * 1. This was the ONLY one of nine directory-creating sites passing no
 *    `mode`, so the state root's permissions depended on which code path
 *    created it first — 0755 at the default umask, 0777 at umask 000, where
 *    every sibling produces 0700. `ensureHttpToken` runs at server startup,
 *    so on a fresh install `serve` is the realistic first toucher. With the
 *    root writable, another user planted a `config.yaml` there — and that
 *    path is live, read last by config lookup, so a planted file steers
 *    routes and credential references.
 *
 * 2. `mode:` on a write applies only when the file is CREATED. Rotating over
 *    an existing 0644 token left it 0644 — and `auth rotate` is the command
 *    you run BECAUSE the token leaked. `workspaces.ts` documents this exact
 *    trap for directories and fixes it with an explicit chmod; the lesson
 *    never reached the file writes.
 *
 * chmod is best-effort: a no-op on Windows, and a token we just wrote
 * successfully should not fail the command because its mode could not be
 * tightened.
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
 * early. That work is now sized by `expected`, not by `value`: the previous
 * version compared the caller-supplied buffer against ITSELF, so its cost
 * scaled with the length an attacker chose, and the comment claiming "a length
 * mismatch alone doesn't leak timing info either" asserted a property the code
 * did not have. The remaining signal is the same for every wrong length, which
 * is what that sentence was meant to say.
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
 *
 * Spelled out because the fail-open branch is one line and reads like a
 * guard clause rather than the policy decision it is.
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
