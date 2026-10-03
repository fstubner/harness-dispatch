import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// bin.ts used to import every command's module, and through them the MCP SDK,
// hono and zod, before reading a flag: 357 files loaded for `status`, which was
// most of its wall time (measured 497 ms -> 193 ms, and 621 ms -> 105 ms for
// `--version`, on the same machine in the same minute). The MCP server is only
// needed by the command that serves, so a one-shot command must not load it.
//
// Spawns the BUILT file, so it needs `npm run build` first, as `npm test` does.

const dist = path.resolve(__dirname, "..", "dist");
const bin = path.join(dist, "bin.js");
const scratch = mkdtempSync(path.join(tmpdir(), "hd-lazy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Records every module URL the process loads, written out on exit.
const hook = path.join(scratch, "hook.mjs");
writeFileSync(
  hook,
  `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const seen = [];
registerHooks({ load(url, ctx, next) { seen.push(url); return next(url, ctx); } });
process.on("exit", () => writeFileSync(process.env.LOADED_OUT, JSON.stringify(seen)));
`,
);

const config = path.join(scratch, "config.yaml");
writeFileSync(
  config,
  [
    "clis:",
    "  - name: fake",
    "    harness: generic",
    "    command: node",
    "    tier: 1",
    "    billing_kind: local_compute",
    "    paid_usage_possible: false",
    '    protocol: { args: ["-e", "0"], output: { mode: text } }',
    "",
  ].join("\n"),
);

function loadedBy(args: string[]): string[] {
  const out = path.join(scratch, `loaded-${args.join("_").replace(/\W+/g, "")}.json`);
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, LOADED_OUT: out, HARNESS_DISPATCH_STATE_DIR: path.join(scratch, "state") },
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(readFileSync(out, "utf8")) as string[];
}

const SERVER_ONLY = [/@modelcontextprotocol/, /node_modules\/hono\//, /node_modules\/zod\//, /dist\/mcp\/server\.js/];

describe.skipIf(!existsSync(bin))("one-shot commands do not load the MCP server", () => {
  it("--version loads no dependency at all", () => {
    const loaded = loadedBy(["--version"]);
    expect(loaded.filter((u) => u.includes("/node_modules/"))).toEqual([]);
  });

  it("status loads neither the MCP SDK, hono, zod nor the server module", () => {
    const loaded = loadedBy(["status", "--json", "--config", config]);
    for (const pattern of SERVER_ONLY) {
      expect(loaded.filter((u) => pattern.test(u)), String(pattern)).toEqual([]);
    }
  });
});
