import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateRoot } from "./state-dir.js";

const TOKEN_ENV = "HARNESS_DISPATCH_HTTP_TOKEN";

export function authDir(): string {
  return process.env.HARNESS_DISPATCH_HOME ?? stateRoot();
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

export async function ensureHttpToken(): Promise<string> {
  const existing = await readHttpToken();
  if (existing) return existing;
  const token = generateHttpToken();
  await fs.mkdir(authDir(), { recursive: true });
  await fs.writeFile(tokenPath(), `${token}\n`, { mode: 0o600 });
  return token;
}

export async function rotateHttpToken(): Promise<string> {
  const token = generateHttpToken();
  await fs.mkdir(authDir(), { recursive: true });
  await fs.writeFile(tokenPath(), `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * Constant-time string compare. `value === expected` short-circuits on the
 * first mismatching byte — a textbook timing side channel for guessing a
 * bearer token one byte at a time. When lengths differ we still run
 * timingSafeEqual (against a same-length dummy) rather than returning early,
 * so a length mismatch alone doesn't leak timing info either.
 */
function safeEqual(value: string, expected: string): boolean {
  const valueBuf = Buffer.from(value, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (valueBuf.length !== expectedBuf.length) {
    timingSafeEqual(valueBuf, valueBuf);
    return false;
  }
  return timingSafeEqual(valueBuf, expectedBuf);
}

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
