import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
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
