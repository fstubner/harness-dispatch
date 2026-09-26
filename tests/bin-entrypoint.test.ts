import { execFile } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// `npm install -g` puts the command on PATH as a link to dist/bin.js whose
// name is `harness-dispatch`, not `bin.js`. Node passes that link path as
// argv[1] unresolved, and a guard that only checked the filename ran nothing
// and exited 0 — every documented command was a silent no-op on Linux and
// macOS through 0.8.0. These spawn the BUILT file through a link, the way npm
// does, so they need `npm run build` first (CI builds before it tests).
//
// The hardlink case runs everywhere: Windows refuses file symlinks without a
// privilege, but a hardlink to a file on the same volume is fine, and it
// exercises the same defect — argv[1] no longer ends in bin.js. The symlink
// case is the exact npm shape and runs where symlinks are allowed.

const run = promisify(execFile);
const dist = path.resolve(__dirname, "..", "dist");
const bin = path.join(dist, "bin.js");
const cleanup: string[] = [];

afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

async function expectHelpVia(link: string): Promise<void> {
  const { stdout } = await run(process.execPath, [link, "--help"]);
  expect(stdout).toContain("Usage:");
}

describe("the built command runs when invoked through a link (as npm installs it)", () => {
  it.skipIf(!existsSync(bin))("hardlink named without .js, beside its imports", async () => {
    // Must live in dist/ itself: a hardlink is the file, so its relative
    // imports resolve from wherever the link sits.
    const link = path.join(dist, `harness-dispatch-entrypoint-${process.pid}`);
    cleanup.push(link);
    linkSync(bin, link);
    await expectHelpVia(link);
  });

  it.skipIf(!existsSync(bin) || process.platform === "win32")(
    "symlink from another directory, the npm bin shape",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "hd-entrypoint-"));
      cleanup.push(dir);
      const link = path.join(dir, "harness-dispatch");
      symlinkSync(bin, link);
      await expectHelpVia(link);
    },
  );
});

describe("--json is a promise about the shape of the output, including on failure", () => {
  /**
   * `--json` was honoured only on the success path. A bad `--config` made
   * `doctor --json` print a sentence, so anything parsing the output got a
   * parse error rather than the reason — carried as an open acceptance item
   * across three releases because it reads as cosmetic. It is not: the whole
   * point of the flag is that a program, not a person, is reading.
   */
  it.skipIf(!existsSync(bin))("reports a bad --config as JSON when --json is given", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hd-json-err-"));
    cleanup.push(dir);
    // A directory, which is a real mistake people make and cannot be a config.
    const err = await run(process.execPath, [bin, "doctor", "--json", "--config", dir]).catch(
      (e: { stderr?: string; stdout?: string }) => e,
    );
    const text = String(err.stderr ?? "");
    const parsed = JSON.parse(text) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("is a directory");
  });

  it.skipIf(!existsSync(bin))("still reports it as a plain line without --json", async () => {
    // The default must not become JSON for a person reading a terminal.
    const dir = mkdtempSync(path.join(tmpdir(), "hd-txt-err-"));
    cleanup.push(dir);
    const err = await run(process.execPath, [bin, "doctor", "--config", dir]).catch(
      (e: { stderr?: string }) => e,
    );
    const text = String(err.stderr ?? "");
    expect(text).toContain("harness-dispatch: ");
    expect(() => JSON.parse(text)).toThrow();
  });
  // Three error shapes wrote to stderr and returned, bypassing the handler
  // that knows about --json, and `unknown command` printed the help block to
  // STDOUT — so `harness-dispatch frobnicate --json | jq` got usage text as
  // its input, the exact pipe the envelope exists to keep parseable. Measured
  // by an acceptance pass.
  const BYPASSED: Array<[string, string[], string]> = [
    ["unknown command", ["frobnicate", "--json"], "unknown command"],
    ["auth with no subcommand", ["auth", "--json"], "expected show or rotate"],
    ["dispatch with no prompt", ["dispatch", "--json"], "missing prompt"],
    // `--json=true` got JSON on success and plain text on failure.
    ["the --json=true spelling", ["frobnicate", "--json=true"], "unknown command"],
  ];

  for (const [label, args, expected] of BYPASSED) {
    it.skipIf(!existsSync(bin))(`${label} reports as JSON`, async () => {
      const err = await run(process.execPath, [bin, ...args]).catch(
        (e: { stderr?: string; stdout?: string }) => e,
      );
      const parsed = JSON.parse(String(err.stderr ?? "")) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(expected);
      // Nothing on stdout, so a pipe reading results is not fed help text.
      expect(String(err.stdout ?? "")).toBe("");
    });
  }

  it.skipIf(!existsSync(bin))("still prints the usage block for a human", async () => {
    // Losing the help for an unknown command would be a worse product than
    // the bug being fixed; it moves to stderr, it does not disappear.
    const err = await run(process.execPath, [bin, "frobnicate"]).catch(
      (e: { stderr?: string }) => e,
    );
    expect(String(err.stderr ?? "")).toContain("Usage:");
  });
});


describe("status --json --watch", () => {
  // It printed pretty-printed documents back to back, which parse neither as
  // one JSON value nor line by line. Found in an audit.
  it.skipIf(!existsSync(bin))("prints one JSON document per line", async () => {
    const { spawn } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(path.join(tmpdir(), "hd-watch-"));
    try {
      const config = path.join(dir, "config.yaml");
      writeFileSync(config, "detect: false\n", "utf8");
      const out = await new Promise<string>((resolve) => {
        const child = spawn(
          process.execPath,
          [bin, "status", "--json", "--watch", "--interval", "200", "--config", config],
          { env: { ...process.env, HARNESS_DISPATCH_STATE_DIR: dir } },
        );
        let text = "";
        child.stdout.on("data", (d: Buffer) => (text += d.toString()));
        setTimeout(() => child.kill(), 2_500);
        child.on("close", () => resolve(text));
      });
      const lines = out.split("\n").filter((l) => l.trim() !== "");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("telemetry and the prompt", () => {
  // `harness-dispatch dispatch "<prompt>"` puts the prompt in argv, and the
  // SDK's default process detector exports argv as `process.command_args`
  // on every span. Measured: a canary prompt reached the collector. Found in
  // an audit.
  it.skipIf(!existsSync(bin))("exports spans without the prompt in them", async () => {
    const { spawn } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const { createServer } = await import("node:http");
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(path.join(tmpdir(), "hd-otel-"));
    try {
      const config = path.join(dir, "config.yaml");
      writeFileSync(
        config,
        [
          "telemetry: { enabled: true }",
          "clis:",
          "  - name: echo_node",
          "    harness: generic",
          "    command: node",
          "    billing_kind: local_compute",
          "    paid_usage_possible: false",
          "    protocol:",
          '      args: ["-e", "console.log(1)", "{{prompt}}"]',
          "      output: { mode: text }",
        ].join("\n"),
        "utf8",
      );
      await new Promise<void>((resolve) => {
        const child = spawn(
          process.execPath,
          [bin, "dispatch", "--config", config, "--service", "echo_node", "--task-type", "review", "PROMPT-CANARY-7731"],
          {
            env: {
              ...process.env,
              HARNESS_DISPATCH_STATE_DIR: dir,
              OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
              OTEL_NODE_RESOURCE_DETECTORS: "",
            },
            stdio: "ignore",
          },
        );
        child.on("exit", () => resolve());
      });
      expect(bodies.length, "no spans were exported, so this proves nothing").toBeGreaterThan(0);
      expect(bodies.some((b) => b.includes("PROMPT-CANARY-7731")), "the prompt was exported").toBe(false);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
