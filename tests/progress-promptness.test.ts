/**
 * Progress has to reach the caller WHILE a dispatch runs, not after it.
 *
 * Two things kept it from doing so, measured over the real MCP stdio server
 * with a CLI printing a short line every 2 s: with one 38-character key
 * configured, zero progress notifications arrived before the response at
 * 9.4 s, and with none configured the last line never arrived at all.
 *
 *   - The stream redactor held back a fixed (longest secret − 1) characters,
 *     so a short line sat in the buffer until the next chunk pushed it out.
 *   - A successful run deletes its partial log before writing its terminal
 *     status, and the watcher relaying that log reopened it per read, so the
 *     final read found nothing.
 */

import { appendFileSync, promises as fs, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { watchUntilTerminal } from "../src/jobs/run.js";
import { clearActiveSecrets, createStreamRedactor, setActiveSecrets } from "../src/redaction.js";
import type { DispatcherEvent, RouterConfig } from "../src/types.js";

// Synthetic, test-only.
const KEY = "sk-hdtest-PROMPT-0123456789";

function withSecrets(...keys: string[]): void {
  const services = Object.fromEntries(keys.map((apiKey, i) => [`r${i}`, { apiKey }]));
  setActiveSecrets({ services } as unknown as RouterConfig);
}

describe("the stream redactor", () => {
  afterEach(() => clearActiveSecrets());

  it("still scrubs a key split across two chunks", () => {
    withSecrets(KEY);
    const r = createStreamRedactor();
    const out = r.push(`rejected key ${KEY.slice(0, 9)}`) + r.push(`${KEY.slice(9)} end\n`) + r.flush();
    expect(out).toBe("rejected key <redacted> end\n");
  });

  it("releases text that cannot start a secret in the same push", () => {
    withSecrets(KEY);
    const r = createStreamRedactor();
    expect(r.push("line 1\n")).toBe("line 1\n");
    expect(r.push("line 2 with no newline")).toBe("line 2 with no newline");
  });

  it("holds a suffix that could start a secret, then releases it once the next chunk shows it is not one", () => {
    withSecrets(KEY);
    const r = createStreamRedactor();
    expect(r.push("value sk-hd")).toBe("value ");
    expect(r.push("-other\n")).toBe("sk-hd-other\n");
    expect(r.flush()).toBe("");
  });

  it("holds the start of a key's JSON-escaped form, which is what a serialized sink sees", () => {
    const quoted = 'pa"ss\\word-0123';
    withSecrets(quoted);
    const escaped = JSON.stringify(quoted).slice(1, -1);
    const r = createStreamRedactor();
    const first = r.push(`{"k":"${escaped.slice(0, 6)}`);
    expect(first).toBe('{"k":"');
    expect(first + r.push(`${escaped.slice(6)}"}`) + r.flush()).toBe('{"k":"<redacted>"}');
  });

  it("holds nothing with no secrets configured", () => {
    const r = createStreamRedactor();
    expect(r.push("sk-")).toBe("sk-");
  });
});

describe("relaying a detached job's partial log", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-progress-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("relays the last lines a successful run wrote before deleting the log", async () => {
    const jobId = "job-1786977300009-0f0ddddd";
    const jobDir = path.join(tmpDir, jobId);
    const output = path.join(jobDir, "output");
    await fs.mkdir(output, { recursive: true });
    const partial = path.join(output, "stdout.partial.log");
    const status = (state: string): string =>
      JSON.stringify({ jobId, status: state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), jobDir });
    writeFileSync(path.join(jobDir, "status.json"), status("running"));
    writeFileSync(partial, "first\n");

    const seen: string[] = [];
    const watch = watchUntilTerminal(jobDir, {
      onEvent: (e: DispatcherEvent) => {
        if (e.type === "stdout") seen.push(e.chunk);
      },
    });
    for (let i = 0; i < 50 && seen.join("") !== "first\n"; i++) await new Promise((r) => setTimeout(r, 50));
    expect(seen.join("")).toBe("first\n");

    // What runJob does on success, in its order: the last append, the delete,
    // then the terminal status. Synchronous, so no read lands in between.
    appendFileSync(partial, "last\n");
    rmSync(partial);
    writeFileSync(path.join(jobDir, "status.json"), status("completed"));
    await watch;

    expect(seen.join("")).toBe("first\nlast\n");
  });
});
