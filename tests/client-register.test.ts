/**
 * Writing to someone else's config file is the riskiest thing this tool does,
 * and the one thing this project has already got wrong: v0.1.0's setup wrote
 * `~/.claude/CLAUDE.md` and a hooks entry, v0.2.0 removed the command, and both
 * artifacts were still on the maintainer's machine seven minor versions later.
 *
 * Every test here is one of those failure modes, not coverage for its own sake.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENTRY_KEY,
  desiredEntry,
  devLaunchCommand,
  planClientWrites,
  removeClientEntry,
  writeClientEntry,
} from "../src/client-register.js";

let home: string;
const CONFIG = "/projects/harness/config.yaml";
/** Pinned so a test never depends on what happens to be installed. */
const COMMAND = ["harness-dispatch"];

const claudeFile = (): string => path.join(home, ".claude.json");
const cursorFile = (): string => path.join(home, ".cursor", "mcp.json");

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function readJson(file: string): Promise<Record<string, never>> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

const plans = (): ReturnType<typeof planClientWrites> =>
  planClientWrites(CONFIG, { home, command: COMMAND });

const planFor = (id: string) => {
  const found = plans().find((p) => p.id === id);
  if (found === undefined) throw new Error(`no plan for ${id}`);
  return found;
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hd-clients-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
});

describe("planClientWrites", () => {
  it("reports a client that is not installed rather than offering to write it", async () => {
    // Nobody should be asked about Cursor on a machine that has never had it.
    await writeJson(claudeFile(), { mcpServers: {} });
    const all = plans();
    expect(all.find((p) => p.id === "cursor")?.state).toBe("absent");
    expect(all.find((p) => p.id === "claude-code")?.state).toBe("missing-entry");
  });

  it("does not touch a config that will not parse", async () => {
    await fs.writeFile(claudeFile(), "{ this is not json", "utf8");
    expect(planFor("claude-code").state).toBe("unreadable");

    const before = await fs.readFile(claudeFile(), "utf8");
    const outcome = await writeClientEntry(planFor("claude-code"), { stamp: "s" });
    expect(outcome.action).toBe("skipped");
    expect(await fs.readFile(claudeFile(), "utf8")).toBe(before);
  });

  it("does not touch a config that parses but is not an object", async () => {
    // "Does it parse" and "is it the shape I am about to merge into" are
    // different questions, and only the first was asked. An array parses, then
    // gets spread into an object: an array-rooted file came back as
    // `{"0":…,"1":…,"mcpServers":{…}}` and connect reported success. A backup
    // made it recoverable, but this module edits ANOTHER application's config,
    // which is the highest-consequence thing here.
    for (const body of ['["some","array","the user had"]', '"a string"', "42"]) {
      await fs.writeFile(claudeFile(), body, "utf8");
      const before = await fs.readFile(claudeFile(), "utf8");
      const outcome = await writeClientEntry(planFor("claude-code"), { stamp: "s" });
      expect(outcome.action, `${body} was rewritten`).toBe("skipped");
      expect(await fs.readFile(claudeFile(), "utf8")).toBe(before);
    }
  });

  it("an EMPTY or absent config is still mergeable — that is the first run", async () => {
    // The guard must refuse only shapes it cannot merge into. `null` and a
    // missing file are the ordinary first-install case, and refusing those
    // would break the command's main purpose.
    await fs.writeFile(claudeFile(), "null", "utf8");
    expect((await writeClientEntry(planFor("claude-code"), { stamp: "s" })).action).toBe("written");
    const after = JSON.parse(await fs.readFile(claudeFile(), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(after.mcpServers?.[ENTRY_KEY]).toBeDefined();
  });

  it("recognises an entry that already matches, so re-running changes nothing", async () => {
    await writeJson(claudeFile(), {
      mcpServers: { [ENTRY_KEY]: desiredEntry(CONFIG, COMMAND) },
    });
    expect(planFor("claude-code").state).toBe("matches");
    expect((await writeClientEntry(planFor("claude-code"), { stamp: "s" })).action).toBe(
      "unchanged",
    );
  });

  it("flags an entry that differs instead of quietly replacing it", async () => {
    // The machine this was written for had a Cursor entry missing --config.
    // It was DIFFERENT, and it was also working; a blind writer would have
    // destroyed a working setup in the name of fixing it.
    await writeJson(cursorFile(), {
      mcpServers: { [ENTRY_KEY]: { command: "npx", args: ["-y", "harness-dispatch"] } },
    });
    expect(planFor("cursor").state).toBe("differs");
  });
});

describe("devLaunchCommand", () => {
  it("writes the checkout's build, preserving fields we do not set", async () => {
    // The case this exists for, from the maintainer's machine: Claude Code was
    // launching a local checkout that was nine commits ahead of the published
    // package, with nothing installed globally. Registering the package form
    // would have swapped a newer server for an older one and called it setup.
    const entry = path.join("H:", "checkout", "dist", "bin.js");
    await writeJson(claudeFile(), {
      mcpServers: {
        [ENTRY_KEY]: { command: "npx", args: ["-y", "harness-dispatch"], cwd: "H:\\checkout" },
      },
    });

    const plan = planClientWrites(CONFIG, { home, command: devLaunchCommand(entry) });
    const claude = plan.find((p) => p.id === "claude-code")!;
    expect(claude.state).toBe("differs");
    // consented: this test exercises the MERGE, not the consent gate — the
    // interactive prompt is what supplies consent in real use.
    await writeClientEntry(claude, { stamp: "s", consented: true });

    const written = (await readJson(claudeFile())).mcpServers[ENTRY_KEY];
    expect(written.command).toBe("node");
    expect(written.args[0]).toBe(path.resolve(entry));
    expect(written.args).toContain("--config");
    // `cwd` is not a field we set, so it survives — same rule that keeps `env`.
    expect(written.cwd).toBe("H:\\checkout");
  });
});

describe("writeClientEntry", () => {
  it("preserves other servers and the env block of our own entry", async () => {
    // ~/.claude.json holds live API keys. Dropping `env` while "fixing" an
    // entry breaks unrelated servers and is unrecoverable from our backup
    // alone if the user has since edited the file.
    await writeJson(claudeFile(), {
      someOtherThing: { keep: true },
      mcpServers: {
        github: { command: "gh-mcp", args: [], env: { TOKEN: "secret" } },
        [ENTRY_KEY]: { command: "old", args: ["--config", "/gone"], env: { KEY: "mine" } },
      },
    });

    // consented for the same reason: the subject here is what survives a
    // write, not whether the write was allowed.
    const outcome = await writeClientEntry(planFor("claude-code"), {
      stamp: "s",
      consented: true,
    });
    expect(outcome.action).toBe("written");

    const after = await readJson(claudeFile());
    expect(after).toMatchObject({ someOtherThing: { keep: true } });
    expect(after.mcpServers.github).toEqual({
      command: "gh-mcp",
      args: [],
      env: { TOKEN: "secret" },
    });
    expect(after.mcpServers[ENTRY_KEY].env).toEqual({ KEY: "mine" });
    expect(after.mcpServers[ENTRY_KEY].command).toBe("harness-dispatch");
  });

  it("writes an absolute --config path", async () => {
    // A relative path, or none, silently falls back to the shipped defaults —
    // so two clients on one machine disagree about which routes exist while
    // both appear to work. That is what made the real bug survive.
    await writeJson(claudeFile(), { mcpServers: {} });
    await writeClientEntry(planFor("claude-code"), { stamp: "s" });
    const args = (await readJson(claudeFile())).mcpServers[ENTRY_KEY].args as string[];
    expect(args).toContain("--config");
    expect(path.isAbsolute(args[args.indexOf("--config") + 1]!)).toBe(true);
  });

  it("backs the file up before touching it", async () => {
    await writeJson(claudeFile(), { mcpServers: {}, marker: "original" });
    const outcome = await writeClientEntry(planFor("claude-code"), { stamp: "stamp1" });
    expect(outcome.backupPath).toBeDefined();
    expect(await readJson(outcome.backupPath!)).toMatchObject({ marker: "original" });
    // Same directory, so it inherits that directory's permissions rather than
    // landing somewhere more readable than the secrets it contains.
    expect(path.dirname(outcome.backupPath!)).toBe(path.dirname(claudeFile()));
  });

  it("leaves no temp file behind", async () => {
    await writeJson(claudeFile(), { mcpServers: {} });
    await writeClientEntry(planFor("claude-code"), { stamp: "s" });
    const left = (await fs.readdir(home)).filter((f) => f.includes("tmp"));
    expect(left).toEqual([]);
  });

  it("keeps the last few backups rather than one per run, forever", async () => {
    // Every write AND every removal takes a backup, and ~/.claude.json holds
    // live API keys — so unbounded accumulation is a growing pile of copies of
    // someone's secrets. An acceptance pass found one already on the
    // maintainer's machine with nothing that would ever remove it.
    await writeJson(claudeFile(), { mcpServers: {} });
    for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]) {
      // Alternate write/remove so each round genuinely changes state and takes
      // a backup, rather than short-circuiting on "already correct".
      await writeClientEntry(planFor("claude-code"), { stamp });
      await removeClientEntry(planFor("claude-code"), { stamp: `${stamp}-r` });
    }

    const backups = (await fs.readdir(home)).filter((f) => f.includes("harness-dispatch-backup"));
    expect(backups.length).toBeLessThanOrEqual(3);
    // The ones kept are the most recent, not an arbitrary three.
    expect(backups.sort().at(-1)).toContain("2026-01-05");
  });

  it("does not delete a backup somebody else made", async () => {
    await writeJson(claudeFile(), { mcpServers: {} });
    const foreign = `${claudeFile()}.my-own-backup`;
    await fs.writeFile(foreign, "mine", "utf8");
    for (const stamp of ["2026-02-01", "2026-02-02", "2026-02-03", "2026-02-04"]) {
      await writeClientEntry(planFor("claude-code"), { stamp });
      await removeClientEntry(planFor("claude-code"), { stamp: `${stamp}-r` });
    }
    await expect(fs.readFile(foreign, "utf8")).resolves.toBe("mine");
  });

  it("is idempotent: the second run reports unchanged and rewrites nothing", async () => {
    await writeJson(claudeFile(), { mcpServers: {} });
    await writeClientEntry(planFor("claude-code"), { stamp: "s1" });
    const contents = await fs.readFile(claudeFile(), "utf8");

    const second = await writeClientEntry(planFor("claude-code"), { stamp: "s2" });
    expect(second.action).toBe("unchanged");
    expect(second.backupPath).toBeUndefined();
    expect(await fs.readFile(claudeFile(), "utf8")).toBe(contents);
  });
});

describe("removeClientEntry", () => {
  it("removes our entry and leaves the rest of the file alone", async () => {
    // Removal ships WITH writing on purpose: entries outliving the feature
    // that created them is exactly how this project went wrong last time.
    await writeJson(claudeFile(), {
      mcpServers: { github: { command: "gh-mcp", args: [] } },
      other: 1,
    });
    await writeClientEntry(planFor("claude-code"), { stamp: "s" });

    const outcome = await removeClientEntry(planFor("claude-code"), { stamp: "s2" });
    expect(outcome.action).toBe("written");

    const after = await readJson(claudeFile());
    expect(after.mcpServers[ENTRY_KEY]).toBeUndefined();
    expect(after.mcpServers.github).toEqual({ command: "gh-mcp", args: [] });
    expect(after.other).toBe(1);
  });

  it("refuses to delete an entry someone edited by hand", async () => {
    await writeJson(cursorFile(), {
      mcpServers: { [ENTRY_KEY]: { command: "node", args: ["/my/own/build.js"] } },
    });
    const outcome = await removeClientEntry(planFor("cursor"), { stamp: "s" });
    expect(outcome.action).toBe("skipped");
    expect(outcome.reason).toContain("by hand");
    expect((await readJson(cursorFile())).mcpServers[ENTRY_KEY]).toBeDefined();

    // ...unless asked explicitly.
    const forced = await removeClientEntry(planFor("cursor"), { stamp: "s", force: true });
    expect(forced.action).toBe("written");
    expect((await readJson(cursorFile())).mcpServers[ENTRY_KEY]).toBeUndefined();
  });

  it("is a no-op when there is nothing of ours to remove", async () => {
    await writeJson(claudeFile(), { mcpServers: { github: { command: "gh-mcp", args: [] } } });
    expect((await removeClientEntry(planFor("claude-code"), { stamp: "s" })).action).toBe(
      "unchanged",
    );
  });
});

describe("writeClientEntry consent", () => {
  it("refuses to overwrite a hand-edited entry without consent", async () => {
    // OPERATIONS.md promised this protection for connect AND connect --remove;
    // only --remove implemented it. An acceptance pass measured `connect
    // --clients claude-code` printing the hand-written entry it was about to
    // destroy, and then destroying it, exit 0.
    await writeJson(claudeFile(), {
      mcpServers: { [ENTRY_KEY]: { command: "node", args: ["/my/own/build.js"] } },
    });
    const outcome = await writeClientEntry(planFor("claude-code"), { stamp: "s" });
    expect(outcome.action).toBe("skipped");
    expect(outcome.reason).toContain("by hand");
    expect((await readJson(claudeFile())).mcpServers[ENTRY_KEY].args).toEqual([
      "/my/own/build.js",
    ]);
  });

  it("writes it when the caller consented", async () => {
    // The interactive prompt shows the diff and asks; that IS the consent, so
    // nothing changes for someone watching it happen.
    await writeJson(claudeFile(), {
      mcpServers: { [ENTRY_KEY]: { command: "node", args: ["/my/own/build.js"] } },
    });
    const outcome = await writeClientEntry(planFor("claude-code"), {
      stamp: "s",
      consented: true,
    });
    expect(outcome.action).toBe("written");
    expect((await readJson(claudeFile())).mcpServers[ENTRY_KEY].command).toBe(
      "harness-dispatch",
    );
  });

  it("still writes a first-time entry without consent, which replaces nothing", async () => {
    await writeJson(claudeFile(), { mcpServers: {} });
    expect((await writeClientEntry(planFor("claude-code"), { stamp: "s" })).action).toBe(
      "written",
    );
  });
});

describe("writeJsonAtomic permissions", () => {
  // it.skipIf, not an early return: an early return REPORTS A PASS for work it
  // did not do. An acceptance pass removed the fix and watched this file report
  // 19 passed / 0 skipped on Windows — a green row for an assertion that never
  // ran, on the only machine the maintainer builds on. The commit that added it
  // claimed it was "skipped on Windows"; it was not.
  it.skipIf(process.platform === "win32")("does not widen the mode of the file it replaces", async () => {
    // `rename` swaps the INODE, so the surviving file takes the TEMP file's
    // mode — 0644 under a typical umask — not its own. A ~/.claude.json that
    // Claude Code created 0600 came back group- and world-readable, and that
    // file holds live API keys. The same module's backup() uses copyFile,
    // which preserves mode, so the two halves of one write path disagreed.
    //
    // Genuinely skipped on Windows, where POSIX modes do not apply — which is
    // exactly why the bug survived: found by reading on a Windows machine and
    // only provable on POSIX. CI's matrix runs ubuntu and macos, so the
    // assertion does execute somewhere.
    await writeJson(claudeFile(), { mcpServers: {} });
    await fs.chmod(claudeFile(), 0o600);

    const outcome = await writeClientEntry(planFor("claude-code"), { stamp: "s" });
    expect(outcome.action).toBe("written");

    const mode = (await fs.stat(claudeFile())).mode & 0o777;
    expect(
      mode & 0o077,
      `mode widened to ${mode.toString(8)} — group/other can now read stored credentials`,
    ).toBe(0);
  });
});
