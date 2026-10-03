/**
 * Starting a process that outlives the one starting it — for real.
 *
 * `spawn(..., { detached: true })` is not enough on Windows. Node's detached
 * flag gives the child its own console and process group, but it stays in
 * every Windows job object its parent is in, and a launcher that wraps
 * `node.exe` in a job with kill-on-close (the nvx shim does; it is how every
 * MCP server on the maintainer's machine starts) kills the whole job when the
 * session ends. Measured: a detached grandchild of a shim-launched node was
 * dead 3 s after its parent exited; the same grandchild launched through WMI
 * was alive. `cmd /c start` and PowerShell `Start-Process` both inherit the
 * job and died too.
 *
 * WMI's `Win32_Process.Create` asks the WMI service to create the process,
 * so its parent is the provider host and it belongs to none of the caller's
 * jobs. Two consequences shape the code below:
 *
 *   - It gets the WMI host's environment, not ours. The startup object takes
 *     an explicit environment, which REPLACES the default one entirely (a
 *     child given only one variable crashed for lack of SystemRoot), so the
 *     whole of `env` is passed. It travels on PowerShell's stdin, never on a
 *     command line, because it holds API keys.
 *   - It cannot redirect stdio. `cmd.exe /c ... >> log 2>&1` does that, so a
 *     process that dies during bootstrap still leaves its reason in the log.
 *
 * POSIX keeps the plain detached spawn: `detached` there is setsid, which
 * leaves the session and process group a terminal or client would signal.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { processAlive } from "./store.js";

export interface DetachedLaunch {
  execPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Receives the process's stdout and stderr. */
  logPath: string;
  cwd?: string;
}

export type LaunchOutcome =
  | { ok: true; method: "wmi" | "spawn"; pid?: number; note?: string; wmiError?: string }
  | { ok: false; error: string };

/** What `launchDetached` needs from the outside world; tests substitute both. */
export interface LaunchSeams {
  platform?: NodeJS.Platform;
  viaWmi?: (spec: DetachedLaunch) => Promise<LaunchOutcome>;
}

/**
 * What a dispatch's caller is told when the background runner was started by
 * the plain-spawn fallback: the run works, but it is not protected from a
 * launcher that kills its descendants when the session ends.
 */
export function fallbackWarning(wmiError: string): string {
  return (
    `The background runner for this job was started with a plain detached spawn because ` +
    `the durable Windows (WMI) launch failed (${wmiError}), so the job may not survive this ` +
    `session ending. Run \`harness-dispatch doctor\` (the job-runner row) to see why WMI is ` +
    `unavailable.`
  );
}

/** How long PowerShell may take to start and ask WMI. Measured 1.0-1.7 s. */
const WMI_LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Start `spec` detached from this process and from any job object it is in.
 * Never throws: a launch that fails is reported, and the caller decides what
 * a missing process means.
 */
export async function launchDetached(spec: DetachedLaunch, seams: LaunchSeams = {}): Promise<LaunchOutcome> {
  if ((seams.platform ?? process.platform) !== "win32") return spawnDetached(spec);
  const viaWmi = await (seams.viaWmi ?? launchViaWmi)(spec);
  if (viaWmi.ok) return viaWmi;
  // WMI can be unavailable (the service disabled by policy, PowerShell
  // removed). A plain detached spawn still survives everything except a
  // launcher that kills its descendants, so it beats not starting at all —
  // and the log says which one this was.
  const fallback = await spawnDetached(spec);
  const note =
    `harness-dispatch: WMI launch failed (${viaWmi.error}); started with a plain ` +
    `detached spawn instead, which does NOT survive a launcher that kills its ` +
    `descendants when the session ends.\n`;
  try {
    appendFileSync(spec.logPath, note, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The log is diagnostics; failing to write it changes nothing.
  }
  return fallback.ok ? { ...fallback, note: note.trim(), wmiError: viaWmi.error } : fallback;
}

function spawnDetached(spec: DetachedLaunch): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let logFd: number | undefined;
    try {
      logFd = openSync(spec.logPath, "a", 0o600);
      const child = spawn(spec.execPath, spec.args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
        env: spec.env,
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      });
      // Without an 'error' listener a failed spawn (EAGAIN, EMFILE, the node
      // binary gone after an upgrade) is an unhandled 'error' event, and that
      // takes down the whole server that was only trying to start a helper.
      child.once("error", (err) => resolve({ ok: false, error: err.message }));
      child.once("spawn", () => resolve({ ok: true, method: "spawn", ...(child.pid !== undefined ? { pid: child.pid } : {}) }));
      child.unref();
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
  });
}

/**
 * Characters a `cmd.exe /c` line cannot carry safely even inside quotes: `"`
 * ends the quoting, `%` expands variables, and a line break ends the command.
 * Paths with them are vanishingly rare; they fall back to a plain spawn.
 */
const CMD_UNSAFE = /["%\r\n]/;

/** PowerShell, reading its request as ASCII-only JSON from stdin. */
const WMI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$in = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$in.env }",
  "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $in.cmd; CurrentDirectory = $in.cwd; ProcessStartupInformation = $startup }",
  "Write-Output \"$($r.ReturnValue) $($r.ProcessId)\"",
].join("; ");

function windowsDir(): string {
  return process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
}

async function launchViaWmi(spec: DetachedLaunch): Promise<LaunchOutcome> {
  const parts = [spec.execPath, ...spec.args, spec.logPath];
  if (parts.some((p) => CMD_UNSAFE.test(p))) {
    return { ok: false, error: "a path contains a character cmd.exe cannot quote" };
  }
  const cmdExe = path.join(windowsDir(), "System32", "cmd.exe");
  const quoted = [spec.execPath, ...spec.args].map((p) => `"${p}"`).join(" ");
  // /s: strip the outer quotes and run the rest verbatim. /d: no AutoRun.
  const commandLine = `"${cmdExe}" /d /s /c "${quoted} >> "${spec.logPath}" 2>&1"`;
  const env = Object.entries(spec.env)
    // `=C:`-style entries are cmd's per-drive cwd bookkeeping, not variables.
    .filter(([k, v]) => v !== undefined && k !== "" && !k.startsWith("="))
    .map(([k, v]) => `${k}=${v}`);
  // ASCII-only, so the console code page PowerShell reads stdin with cannot
  // mangle a non-ASCII path or value: ConvertFrom-Json decodes the escapes.
  const request = JSON.stringify({ cmd: commandLine, cwd: spec.cwd ?? process.cwd(), env }).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const powershell = path.join(windowsDir(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) return { ok: false, error: `${powershell} not found` };

  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (outcome: LaunchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", WMI_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `PowerShell did not answer within ${WMI_LAUNCH_TIMEOUT_MS / 1000}s` });
    }, WMI_LAUNCH_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.once("error", (e) => finish({ ok: false, error: e.message }));
    child.once("close", (code) => {
      const m = /^(\d+)\s+(\d+)?/m.exec(out.trim());
      if (code === 0 && m !== null && m[1] === "0") {
        finish({ ok: true, method: "wmi", ...(m[2] !== undefined ? { pid: Number(m[2]) } : {}) });
        return;
      }
      const why = m !== null ? `Win32_Process.Create returned ${m[1]}` : err.trim().split(/\r?\n/)[0] || `exit ${code}`;
      finish({ ok: false, error: why });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(request);
  });
}

/**
 * The launcher a client's `node` resolves to, when it is not node itself.
 *
 * `harness-dispatch`, `npx` and a `node <path>` entry all end up running the
 * first `node` on PATH. On a machine with a version-manager shim there, that is
 * the shim, and the shim is what kills its descendants — so the probe has to
 * run under it. Skipped: any `node` that IS this executable (a hardlink or
 * symlink to it). nvx puts such a direct link first on the PATH of everything
 * it starts, so without the skip the probe ran under plain node, passed, and
 * proved nothing. With no shim on PATH this is plain node, which is right.
 */
export function launcherNode(): string {
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  let self: { dev: number; ino: number } | undefined;
  try {
    self = statSync(process.execPath);
  } catch {
    self = undefined;
  }
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      let info;
      try {
        info = statSync(candidate);
      } catch {
        continue;
      }
      if (self !== undefined && info.dev === self.dev && info.ino === self.ino) continue;
      return candidate;
    }
  }
  return process.execPath;
}

/** How long the probe's grandchild waits after its parent is gone before calling it survived. */
const PROBE_SETTLE_MS = 2_000;

/**
 * Does a process started the way supervisors are started outlive the process
 * that started it, when that process runs under the same launcher a client
 * uses?
 *
 * Three generations, because the failure needs all three: the launcher (e.g. a
 * shim holding a kill-on-close job), the parent it starts, and the grandchild
 * the parent launches through `launchDetached`. The parent exits at once,
 * which ends the launcher and closes its job; the grandchild then has to still
 * be alive. That is exactly what happens to a supervisor when the session that
 * started its MCP server ends.
 */
export async function probeDetachedSurvival(
  runnerPath: string,
  probeDir: string,
): Promise<{ ok: boolean; warn?: boolean; detail: string }> {
  const launcher = launcherNode();
  const started = Date.now();
  const parentExit = await new Promise<number | null>((resolve) => {
    const parent = spawn(launcher, [runnerPath, "--detach-probe", probeDir], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      parent.kill();
      resolve(null);
    }, WMI_LAUNCH_TIMEOUT_MS + 10_000);
    parent.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    parent.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(path.join(probeDir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  if (parentExit !== 0) {
    return { ok: false, detail: `the probe's parent process failed (exit ${parentExit}) under ${launcher}` };
  }
  const launch = read("launched.json");
  const deadline = Date.now() + PROBE_SETTLE_MS + 8_000;
  while (Date.now() < deadline && read("survived") === undefined) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const how = launch !== undefined ? (JSON.parse(launch) as LaunchOutcome) : undefined;
  return probeVerdict({
    how,
    survived: read("survived") !== undefined,
    launcher,
    tookMs: Date.now() - started,
    log: (read("child.log") ?? "").trim().split(/\r?\n/).slice(-3).join(" | "),
  });
}

/**
 * What the probe observed, as doctor's row. A survivor that got there by the
 * plain-spawn fallback is a `warn`: it outlived this launcher, but the durable
 * WMI launch is broken, so a launcher that kills its descendants would take
 * real jobs with it.
 */
export function probeVerdict(o: {
  how: LaunchOutcome | undefined;
  survived: boolean;
  launcher: string;
  tookMs: number;
  log: string;
}): { ok: boolean; warn?: boolean; detail: string } {
  const { how, launcher } = o;
  const method = how?.ok ? how.method : "none";
  const wmiError = how?.ok ? how.wmiError : undefined;
  const nextStep =
    wmiError !== undefined
      ? ` The durable Windows (WMI) launch failed (${wmiError}) and the plain-spawn fallback ran ` +
        `instead, so jobs started this way die with their session under a launcher that kills ` +
        `its descendants. Next: make the WMI service and Windows PowerShell available (the ` +
        `service "Windows Management Instrumentation" must be running), then re-run doctor.`
      : "";
  if (o.survived) {
    return {
      ok: true,
      ...(wmiError !== undefined ? { warn: true } : {}),
      detail:
        `a background run outlives the session that started it (launched via ${method}, ` +
        `parent run under ${launcher}; probe took ${o.tookMs} ms)` +
        nextStep,
    };
  }
  const why =
    how === undefined
      ? "the probe recorded no launch at all"
      : !how.ok
        ? `a background run could not be started: ${how.error}`
        : // Started and then gone, whether before or after its first write: a
          // child killed along with its parent's job usually dies before Node
          // has even booted.
          `a background run was KILLED when the process that started it exited ` +
          `(launched via ${method}, parent run under ${launcher}). Jobs will die with ` +
          `the session that dispatched them.`;
  return { ok: false, detail: why + nextStep + (o.log !== "" ? ` Log: ${o.log}` : "") };
}

/** The probe's middle generation: launch the grandchild, record how, exit. */
export async function runDetachProbeParent(runnerPath: string, probeDir: string): Promise<void> {
  const outcome = await launchDetached({
    execPath: process.execPath,
    args: [runnerPath, "--detach-probe-child", probeDir, String(process.pid)],
    env: process.env,
    logPath: path.join(probeDir, "child.log"),
  });
  writeFileSync(path.join(probeDir, "launched.json"), JSON.stringify(outcome), "utf8");
}

/** The probe's grandchild: wait for the parent to be gone, then a little longer. */
export async function runDetachProbeChild(probeDir: string, parentPid: number): Promise<void> {
  writeFileSync(path.join(probeDir, "child-started"), String(process.pid), "utf8");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && processAlive(parentPid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));
  writeFileSync(path.join(probeDir, "survived"), String(process.pid), "utf8");
}
