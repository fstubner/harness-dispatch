/**
 * An agent that a dispatch started may not dispatch, whatever kind of route it
 * asks for.
 *
 * The refusal used to live only in the CLI dispatcher, so a delegate at depth 1
 * that dispatched to an endpoint route sent the request. It is now made where a
 * dispatch is accepted, from the accepting process's own environment.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cmdDispatch } from "../src/cli/dispatch.js";
import { loadConfig } from "../src/config.js";
import { startAsyncJobTracked } from "../src/jobs.js";
import { RuntimeHolder } from "../src/mcp/config-hot-reload.js";
import { buildDispatchers } from "../src/mcp/dispatcher-factory.js";
import { QuotaCache } from "../src/quota.js";
import { Router } from "../src/router.js";
import { throwawayQuotaStateFile } from "./support/fixtures.js";

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hd-nested-"));
  vi.stubEnv("HARNESS_DISPATCH_JOBS_DIR", path.join(dir, "jobs"));
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A holder with one endpoint route and no CLI route at all. */
async function endpointDeps(): Promise<{ holder: RuntimeHolder }> {
  const file = path.join(dir, "config.yaml");
  await fs.writeFile(
    file,
    [
      "endpoints:",
      "  - name: remote",
      "    base_url: https://api.example.test/v1",
      "    model: m",
      "    api_key: sk-not-a-real-key-0123456789",
      "    allow_paid_usage: true",
      "",
    ].join("\n"),
    "utf8",
  );
  const config = await loadConfig(file, { whichFn: async () => null });
  const dispatchers = buildDispatchers(config);
  const quota = new QuotaCache(dispatchers, { stateFile: throwawayQuotaStateFile() });
  const router = new Router(config, quota, dispatchers);
  return { holder: new RuntimeHolder({ config, dispatchers, quota, router, mtimeMs: 0 } as never) };
}

describe("nested dispatch", () => {
  it("lets a dispatch that no dispatch started reach an endpoint route", async () => {
    // The control: without it a refusal test below could pass because nothing
    // ever reaches the network in this setup.
    const started = await startAsyncJobTracked(await endpointDeps(), {
      prompt: "hello",
      workingDir: dir,
      service: "remote",
    });
    await started.completion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an endpoint route at depth 1 and makes no request", async () => {
    vi.stubEnv("HARNESS_DISPATCH_DEPTH", "1");
    await expect(
      startAsyncJobTracked(await endpointDeps(), { prompt: "hello", workingDir: dir, service: "remote" }),
    ).rejects.toThrow(/may not dispatch at all/);
    // Unrouted too: the refusal does not depend on which route would be chosen.
    await expect(
      startAsyncJobTracked(await endpointDeps(), { prompt: "hello", workingDir: dir }),
    ).rejects.toThrow(/HARNESS_DISPATCH_DEPTH=1/);
    expect(fetchMock).not.toHaveBeenCalled();
    // Refused before a job exists, so there is nothing to list or to blame on a route.
    expect(await fs.readdir(path.join(dir, "jobs")).catch(() => [])).toEqual([]);
  });

  it("refuses the command-line dispatch when nested", async () => {
    vi.stubEnv("HARNESS_DISPATCH_DEPTH", "2");
    await expect(
      cmdDispatch("hello", undefined, { noFallback: false, json: false }),
    ).rejects.toThrow(/may not dispatch at all/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
