/**
 * Minor findings 7-10 of the independent acceptance review.
 *
 * None breaks anything. Each makes a user work harder than necessary to find
 * out what happened — which for a tool whose primary consumer is an agent
 * means reasoning from a worse picture.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildDispatchers } from "../src/mcp/dispatcher-factory.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hr-errq-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("endpoint failures name the endpoint and the cause", () => {
  async function dispatchTo(baseUrl: string): Promise<string> {
    const file = path.join(dir, `e-${Buffer.from(baseUrl).toString("hex").slice(0, 10)}.yaml`);
    await fs.writeFile(
      file,
      `endpoints:\n  - name: dead\n    base_url: ${baseUrl}\n    model: m\n`,
      "utf8",
    );
    const cfg = await loadConfig(file, { whichFn: async () => null });
    const result = await buildDispatchers(cfg)["dead"]!.dispatch("hi", [], dir);
    return result.error ?? "";
  }

  it("explains a refused connection instead of saying only 'fetch failed'", async () => {
    // undici says exactly "fetch failed" for DNS, refusal and TLS alike. For a
    // router whose job is choosing between endpoints, which one and why is the
    // entire content of the message.
    const err = await dispatchTo("http://127.0.0.1:59999/v1");
    expect(err).toMatch(/connection refused/);
    expect(err).toContain("59999");
  }, 30_000);

  it("explains an unresolvable host", async () => {
    const err = await dispatchTo("http://no-such-host-xyz.invalid/v1");
    expect(err).toMatch(/does not resolve/);
  }, 30_000);
});
