import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock the PATH lookup so we can control what the resolver sees without
// depending on what's actually installed on the test machine.
vi.mock("../src/dispatchers/shared/which-available.js", () => ({
  findOnPath: vi.fn(),
  findAllOnPath: vi.fn(),
}));

import { findAllOnPath, findOnPath } from "../src/dispatchers/shared/which-available.js";
import { resolveCliCommand } from "../src/dispatchers/shared/windows-cmd.js";

const mockedFind = findOnPath as unknown as ReturnType<typeof vi.fn>;
const mockedFindAll = findAllOnPath as unknown as ReturnType<typeof vi.fn>;

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  mockedFindAll.mockReturnValue([]);
});

afterEach(() => {
  setPlatform(originalPlatform);
  mockedFind.mockReset();
  mockedFindAll.mockReset();
});

describe("resolveCliCommand — non-Windows", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  it("returns the resolved absolute path with no prefix for a plain binary", async () => {
    mockedFind.mockReturnValueOnce("/usr/local/bin/claude");
    const result = await resolveCliCommand("claude");
    expect(result).toEqual({ command: "/usr/local/bin/claude", prefixArgs: [] });
  });

  it("does not wrap .cmd files on non-Windows (the extension is just a name there)", async () => {
    mockedFind.mockReturnValueOnce("/opt/bin/cursor.cmd");
    const result = await resolveCliCommand("cursor");
    expect(result).toEqual({ command: "/opt/bin/cursor.cmd", prefixArgs: [] });
  });

  it("falls back to the raw bin name if nothing is found on PATH", async () => {
    mockedFind.mockReturnValueOnce(undefined);
    const result = await resolveCliCommand("nonexistent");
    expect(result).toEqual({ command: "nonexistent", prefixArgs: [] });
  });
});

describe("resolveCliCommand — Windows", () => {
  beforeEach(() => {
    setPlatform("win32");
  });

  it("resolves a plain .cmd wrapper to its path with no prefix, for cross-spawn to handle safely", async () => {
    // Used to return { command: "cmd", prefixArgs: ["/c", path] } and let
    // dispatchers spawn that directly — Node's spawn() only safely escapes
    // cmd.exe metacharacters when IT decides the shell indirection is
    // needed, so manually pre-building the "cmd /c" invocation bypassed
    // that (confirmed exploitable: a `"` in an argument broke out of the
    // quoting and let a chained `&` command execute). cross-spawn (the
    // actual spawn() used downstream) detects .bat/.cmd targets itself and
    // escapes correctly, so this just needs to hand back the resolved path.
    mockedFind.mockReturnValueOnce(
      "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd",
    );
    const result = await resolveCliCommand("claude");
    expect(result).toEqual({
      command: "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd",
      prefixArgs: [],
    });
  });

  it("rewrites npm .cmd shims to node plus the real CLI JavaScript entrypoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-dispatch-cmd-"));
    const cmdPath = path.join(root, "gemini.cmd");
    const scriptPath = path.join(
      root,
      "node_modules",
      "@google",
      "gemini-cli",
      "bundle",
      "gemini.js",
    );
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, "console.log('gemini');\n", "utf8");
    await fs.writeFile(
      cmdPath,
      [
        "@ECHO off",
        "SETLOCAL",
        "CALL :find_dp0",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*',
        "",
      ].join("\n"),
      "utf8",
    );

    mockedFind.mockReturnValueOnce(cmdPath);
    const result = await resolveCliCommand("gemini");

    expect(result).toEqual({
      command: process.execPath,
      prefixArgs: [scriptPath],
    });

    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves a plain .bat wrapper to its path with no prefix, for cross-spawn to handle safely", async () => {
    mockedFind.mockReturnValueOnce("C:\\Tools\\gemini.bat");
    const result = await resolveCliCommand("gemini");
    expect(result).toEqual({
      command: "C:\\Tools\\gemini.bat",
      prefixArgs: [],
    });
  });

  it("is case-insensitive on the extension (.CMD / .BAT)", async () => {
    mockedFind.mockReturnValueOnce("C:\\Tools\\x.CMD");
    const result = await resolveCliCommand("x");
    expect(result.command).toBe("C:\\Tools\\x.CMD");
    expect(result.prefixArgs).toEqual([]);
  });

  it("handles paths containing spaces correctly (path is passed through as a single element)", async () => {
    mockedFind.mockReturnValueOnce(
      "C:\\Program Files\\My Tools\\codex.cmd",
    );
    const result = await resolveCliCommand("codex");
    expect(result).toEqual({
      command: "C:\\Program Files\\My Tools\\codex.cmd",
      prefixArgs: [],
    });
  });

  it("skips WindowsApps .exe aliases because Node may not be allowed to spawn them directly", async () => {
    mockedFind.mockReturnValueOnce("C:\\Fake Node\\codex.cmd");
    mockedFindAll.mockReturnValueOnce([
      "C:\\Fake Node\\codex",
      "C:\\Fake Node\\codex.cmd",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe",
    ]);
    const result = await resolveCliCommand("codex");
    expect(result).toEqual({
      command: "C:\\Fake Node\\codex.cmd",
      prefixArgs: [],
    });
  });

  it("prefers a native .exe candidate over npm .cmd wrappers when it is directly spawnable", async () => {
    mockedFind.mockReturnValueOnce("C:\\Program Files\\nodejs\\tool.cmd");
    mockedFindAll.mockReturnValueOnce([
      "C:\\Program Files\\nodejs\\tool",
      "C:\\Program Files\\nodejs\\tool.cmd",
      "C:\\Tools\\tool.exe",
    ]);
    const result = await resolveCliCommand("tool");
    expect(result).toEqual({
      command: "C:\\Tools\\tool.exe",
      prefixArgs: [],
    });
  });

  it("falls back to the first wrapper when no native .exe candidate exists", async () => {
    mockedFind.mockReturnValueOnce("C:\\Users\\test\\AppData\\Roaming\\npm\\gemini.cmd");
    mockedFindAll.mockReturnValueOnce([
      "C:\\Users\\test\\AppData\\Roaming\\npm\\gemini",
      "C:\\Users\\test\\AppData\\Roaming\\npm\\gemini.cmd",
    ]);
    const result = await resolveCliCommand("gemini");
    expect(result).toEqual({
      command: "C:\\Users\\test\\AppData\\Roaming\\npm\\gemini.cmd",
      prefixArgs: [],
    });
  });

  it("does NOT wrap native .exe executables", async () => {
    mockedFind.mockReturnValueOnce("C:\\Windows\\System32\\python.exe");
    const result = await resolveCliCommand("python");
    expect(result).toEqual({
      command: "C:\\Windows\\System32\\python.exe",
      prefixArgs: [],
    });
  });

  it("does not wrap extensionless resolved paths", async () => {
    // Unusual on Windows but guard against it.
    mockedFind.mockReturnValueOnce("C:\\tools\\weirdbin");
    const result = await resolveCliCommand("weirdbin");
    expect(result.prefixArgs).toEqual([]);
  });

  it("returns raw bin name when nothing on PATH resolves", async () => {
    mockedFind.mockReturnValueOnce(undefined);
    const result = await resolveCliCommand("missing");
    expect(result).toEqual({ command: "missing", prefixArgs: [] });
  });
});
