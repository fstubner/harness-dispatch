import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isUneditedGenerated, stampGenerated } from "../src/configure-yaml.js";

// The natural first-run order: install this tool, configure (finds nothing),
// install a harness, configure again. The second run was refused — "already
// exists ... --force" — and, had the first run found anything, loading that
// file would have made it authoritative and hidden the new harness anyway.
//
// `which` is mocked against a mutable set so "a harness appeared" is one
// line, and modules are reset between runs because config.ts caches lookups
// for the life of the process — exactly what a second CLI invocation is not.

const installed = vi.hoisted(() => new Set<string>());
vi.mock("which", () => ({
  default: async (cmd: string) => (installed.has(cmd) ? `/fake/bin/${cmd}` : null),
}));

let dir: string;
let target: string;
let savedEnvConfig: string | undefined;

async function configure(...extra: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  vi.resetModules();
  const { main } = await import("../src/bin.js");
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (c: string) => (out.push(String(c)), true);
  (process.stderr as unknown as { write: unknown }).write = (c: string) => (err.push(String(c)), true);
  try {
    const code = await main(["configure", "--yes", "--no-clients", "--config", target, ...extra]);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origOut;
    (process.stderr as unknown as { write: unknown }).write = origErr;
  }
}

beforeEach(async () => {
  installed.clear();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-rerun-"));
  target = path.join(dir, "config.yaml");
  savedEnvConfig = process.env["HARNESS_DISPATCH_CONFIG"];
  delete process.env["HARNESS_DISPATCH_CONFIG"];
});

afterEach(async () => {
  if (savedEnvConfig === undefined) delete process.env["HARNESS_DISPATCH_CONFIG"];
  else process.env["HARNESS_DISPATCH_CONFIG"] = savedEnvConfig;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("re-running configure", () => {
  it("regenerates its own unedited output and picks up a harness installed since", async () => {
    const first = await configure();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Detected 0 harness routes");
    const written = await fs.readFile(target, "utf8");
    expect(isUneditedGenerated(written)).toBe(true);
    expect(written).not.toContain("codex_cli");

    installed.add("codex");
    const second = await configure();
    expect(second.stderr).not.toContain("already exists");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Detected 1 harness route");
    expect(second.stdout).toContain("regenerating it from this detection");
    const regenerated = await fs.readFile(target, "utf8");
    expect(regenerated).toContain("name: codex_cli");
    expect(isUneditedGenerated(regenerated)).toBe(true);

    // And again with nothing new: still not a refusal.
    expect((await configure()).code).toBe(0);
  });

  it("still refuses a generated file that has been edited, until --force", async () => {
    // With a route, so the body is a block mapping a line can be appended to.
    installed.add("codex");
    expect((await configure()).code).toBe(0);
    await fs.appendFile(target, "max_concurrent_runs: 2\n", "utf8");
    const refused = await configure();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(await fs.readFile(target, "utf8")).toContain("max_concurrent_runs: 2");
    expect((await configure("--force")).code).toBe(0);
  });

  it("says so when --force over an edited file skips detection, instead of claiming one", async () => {
    // The acceptance pass for 0.9.0: edited codex-only file, claude installed
    // since, `--force` printed "Detected 1 harness route" and wrote codex only.
    installed.add("codex");
    expect((await configure()).code).toBe(0);
    await fs.appendFile(target, "max_concurrent_runs: 2\n", "utf8");
    installed.add("claude");
    const forced = await configure("--force");
    expect(forced.code).toBe(0);
    expect(forced.stdout).not.toMatch(/Detected \d+ harness route/);
    expect(forced.stdout).toContain("detection did not run");
    expect(forced.stdout).toContain("detect: true");
    expect(await fs.readFile(target, "utf8")).not.toContain("claude_code_cli");
  });

  it("treats a line added above the fingerprint as an edit", async () => {
    installed.add("codex");
    expect((await configure()).code).toBe(0);
    const text = await fs.readFile(target, "utf8");
    await fs.writeFile(target, `detect: false\n${text}`, "utf8");
    expect((await configure()).code).toBe(1);
  });
});

describe("isUneditedGenerated", () => {
  it("is not fooled by line endings, and is by a changed byte", () => {
    const stamped = stampGenerated("clis: []\n");
    expect(isUneditedGenerated(stamped)).toBe(true);
    expect(isUneditedGenerated(stamped.replace(/\n/g, "\r\n"))).toBe(true);
    expect(isUneditedGenerated(stamped.replace("clis: []", "clis: [ ]"))).toBe(false);
    expect(isUneditedGenerated("clis: []\n")).toBe(false);
  });

  it("counts a comment the user put above the header as an edit, and a stripped final newline as none", () => {
    // Twenty-fifth pass, finding 4: a `# note` on top was regenerated away
    // silently, while an editor dropping the trailing newline forced --force.
    const stamped = stampGenerated("clis: []\n");
    expect(isUneditedGenerated(`# note to self\n${stamped}`)).toBe(false);
    expect(isUneditedGenerated(stamped.replace(/\n$/, ""))).toBe(true);
  });
});
