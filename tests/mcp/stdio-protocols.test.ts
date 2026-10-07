/**
 * The BUILT server over real stdio, driven as each MCP protocol revision's
 * client drives it.
 *
 * Two kinds of client reach this server. Codex, Cursor and older Claude Code
 * open with the `initialize` handshake (2025-era). A client speaking MCP
 * 2026-07-28 sends no handshake at all: it may probe with `server/discover`,
 * and names its protocol version, capabilities and itself in every request's
 * `_meta`. The SDK serves both from one factory, and nearly everything this
 * server cares about moved for the second kind — where the client's name is
 * read, how progress is sent — so each surface is asserted for each kind.
 *
 * Raw JSON-RPC lines rather than an SDK client: the point is to send exactly
 * what the spec says each kind sends, independent of what any client library
 * version chooses to do.
 *
 * Needs `npm run build` first, like the other tests that spawn dist/.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "bin.js");

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "modern-test-client", version: "2.0" },
};

/** One `harness-dispatch mcp` process with a fake CLI route and throwaway state. */
class StdioServer {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (m: RpcMessage) => void>();
  readonly notifications: RpcMessage[] = [];
  root = "";

  constructor(private readonly meta: Record<string, unknown>) {}

  async start(): Promise<void> {
    this.root = await fs.mkdtemp(path.join(os.tmpdir(), "hd-stdio-proto-"));
    const configPath = path.join(this.root, "config.yaml");
    // Prints four lines 300 ms apart, so a dispatch waiting on it has output
    // to report as progress before it finishes.
    const script =
      "let i = 0; const t = setInterval(() => { i += 1; console.log('line ' + i); " +
      "if (i === 4) clearInterval(t); }, 300)";
    // A config that lists its own routes is authoritative: nothing installed
    // on this machine is auto-detected into it.
    await fs.writeFile(
      configPath,
      [
        "instructions: operator text for the protocol test",
        "clis:",
        "  - name: fake_cli",
        "    harness: generic",
        "    command: node",
        "    tier: 3",
        "    billing_kind: local_compute",
        "    paid_usage_possible: false",
        "    protocol:",
        `      args: ["-e", ${JSON.stringify(script)}, "{{prompt}}"]`,
        "      output: { mode: text }",
      ].join("\n"),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HARNESS_DISPATCH_CONFIG: configPath,
      HARNESS_DISPATCH_STATE_DIR: path.join(this.root, "state"),
      HARNESS_DISPATCH_JOBS_DIR: path.join(this.root, "jobs"),
      HARNESS_DISPATCH_LOG_DIR: path.join(this.root, "logs"),
    };
    delete env.HARNESS_DISPATCH_DEPTH;
    this.child = spawn(process.execPath, [BIN, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line === "") continue;
        const msg = JSON.parse(line) as RpcMessage;
        const resolve = msg.id !== undefined && msg.method === undefined ? this.pending.get(msg.id) : undefined;
        if (resolve !== undefined) {
          this.pending.delete(msg.id!);
          resolve(msg);
        } else {
          this.notifications.push(msg);
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}, extraMeta: Record<string, unknown> = {}): Promise<RpcMessage> {
    const id = this.nextId++;
    const meta = { ...this.meta, ...extraMeta };
    const body = Object.keys(meta).length > 0 ? { ...params, _meta: meta } : params;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: body })}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`no answer to ${method}`)), 45_000).unref();
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  /** Dispatch to the fake route and return the job's recorded caller. */
  async dispatch(): Promise<{ response: RpcMessage; progress: RpcMessage[]; caller: Record<string, unknown> }> {
    const before = this.notifications.length;
    const response = await this.request(
      "tools/call",
      {
        name: "dispatch",
        arguments: { prompt: "hi", workingDir: this.root, hints: { taskType: "plan" }, graceSeconds: 30 },
      },
      { progressToken: `p${this.nextId}` },
    );
    const progress = this.notifications.slice(before).filter((n) => n.method === "notifications/progress");
    const text = (response.result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "{}";
    const { jobId } = JSON.parse(text) as { jobId?: string };
    const manifest = JSON.parse(
      await fs.readFile(path.join(this.root, "jobs", String(jobId), "manifest.json"), "utf8"),
    ) as { caller?: Record<string, unknown> };
    return { response, progress, caller: manifest.caller ?? {} };
  }

  async jobCount(): Promise<number> {
    const entries = await fs.readdir(path.join(this.root, "jobs")).catch(() => [] as string[]);
    return entries.filter((n) => !n.startsWith(".")).length;
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 5_000);
      this.child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
    });
    await fs.rm(this.root, { recursive: true, force: true, maxRetries: 5 });
  }
}

const KINDS = [
  { kind: "2025-era client (initialize handshake)", meta: {}, clientName: "legacy-test-client", modern: false },
  { kind: "2026-07-28 client (no handshake, per-request _meta)", meta: MODERN_META, clientName: "modern-test-client", modern: true },
] as const;

describe.skipIf(!existsSync(BIN)).each(KINDS)("built server over stdio — $kind", ({ meta, clientName, modern }) => {
  const server = new StdioServer(meta);
  let opening: RpcMessage;

  beforeAll(async () => {
    await server.start();
    if (modern) {
      opening = await server.request("server/discover");
    } else {
      opening = await server.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0" },
      });
      server.notify("notifications/initialized");
    }
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it("delivers the server instructions, operator text included, in the opening exchange", () => {
    // 2025-era: the initialize result. 2026-07-28: the server/discover result.
    expect(opening.error, JSON.stringify(opening.error)).toBeUndefined();
    const instructions = String(opening.result?.instructions ?? "");
    expect(instructions).toContain("`dispatch` always starts new work");
    expect(instructions).toContain("operator text for the protocol test");
    if (modern) expect(opening.result?.supportedVersions).toContain("2026-07-28");
  });

  it("lists the six tools with their annotations", async () => {
    const listed = await server.request("tools/list");
    const tools = listed.result?.tools as Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> } }>;
    expect(tools.map((t) => t.name)).toEqual(["dispatch", "job_status", "cancel_job", "retry_job", "workspace", "usage"]);
    expect(tools.find((t) => t.name === "job_status")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "workspace")?.annotations?.destructiveHint).toBe(true);
    expect(Object.keys(tools[0]!.inputSchema.properties)).toContain("hints");
  });

  it("reads both status resources", async () => {
    const json = await server.request("resources/read", { uri: "harness-dispatch://status.json" });
    const contents = json.result?.contents as Array<{ text: string }>;
    const status = JSON.parse(contents[0]!.text) as { routes: Array<{ id: string }> };
    expect(status.routes.map((r) => r.id)).toEqual(["fake_cli"]);
    const text = await server.request("resources/read", { uri: "harness-dispatch://status" });
    expect((text.result?.contents as Array<{ text: string }>)[0]!.text).toContain("harness-dispatch status");
  });

  it("dispatches, sends progress while it waits, and records the client and its connection", async () => {
    const first = await server.dispatch();
    expect(first.response.error, JSON.stringify(first.response.error)).toBeUndefined();
    const body = JSON.parse((first.response.result!.content as Array<{ text: string }>)[0]!.text) as {
      completed: boolean;
      route: string;
      output: string;
    };
    expect(body).toMatchObject({ completed: true, route: "fake_cli" });
    expect(body.output).toContain("line 4");
    expect(first.progress.length, "no progress notification during the grace window").toBeGreaterThan(0);
    expect(first.caller.client).toBe(clientName);
    expect(first.caller.session).toMatch(/^[0-9a-f-]{36}$/);

    // One id per connection: a second dispatch on the same stdio connection
    // is recorded under the same one.
    const second = await server.dispatch();
    expect(second.caller.session).toBe(first.caller.session);
  }, 60_000);

  it("refuses a near-miss argument as a protocol error and starts nothing", async () => {
    const before = await server.jobCount();
    const refused = await server.request("tools/call", {
      name: "dispatch",
      arguments: { prompt: "hi", workingDir: server.root, safteyProfile: "read_only" },
    });
    expect(refused.error?.code).toBe(-32602);
    expect(refused.error?.message).toMatch(/did you mean safetyProfile/);
    expect(await server.jobCount()).toBe(before);
  });
});
