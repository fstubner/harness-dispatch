/**
 * A config saved again while the server is still reading the previous save.
 *
 * The runtime recorded the file's mtime AFTER reading it, so an edit landing
 * in between was recorded as already loaded: the older content ran under the
 * newer mtime, and the newer edit — a route disabled, a safety setting — was
 * never loaded, with nothing reporting it. Found in an audit. The read is
 * hooked to land the second save at exactly that moment.
 */
import { promises as fsp, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapRuntime, ConfigHotReloader, RuntimeHolder } from "../src/mcp/config-hot-reload.js";

const EP = (model: string): string =>
  ["detect: false", "endpoints:", "  - name: ep", "    base_url: http://localhost:11434/v1", `    model: ${model}`, ""].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an edit that lands while the config is being read", () => {
  it("is loaded on the next check instead of never", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hd-reload-race-"));
    const file = path.join(dir, "config.yaml");
    writeFileSync(file, EP("first"), "utf8");
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);

    const realReadFile = fsp.readFile.bind(fsp);
    let raced = false;
    vi.spyOn(fsp, "readFile").mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const text = await (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      if (!raced && typeof p === "string" && path.resolve(p) === path.resolve(file)) {
        raced = true;
        writeFileSync(file, EP("second"), "utf8");
      }
      return text;
    }) as typeof fsp.readFile);

    try {
      const state = await bootstrapRuntime({ configPath: file });
      expect(raced, "the hook never ran, so this proves nothing").toBe(true);
      expect(state.config.services["ep"]!.model).toBe("first");
      vi.restoreAllMocks();

      const holder = new RuntimeHolder(state);
      const reloaded = await new ConfigHotReloader(holder, file).maybeReload();
      expect(reloaded, "the second save was recorded as already loaded").toBe(true);
      expect(holder.state.config.services["ep"]!.model).toBe("second");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
