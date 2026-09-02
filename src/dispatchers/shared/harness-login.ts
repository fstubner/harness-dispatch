/**
 * Asks a harness CLI whether it is logged in.
 *
 * `doctor` reported a Codex route as `ok` on routes, billing and safety while
 * the CLI had never been logged in, and the first dispatch then failed with a
 * raw OpenAI `401 Unauthorized ... Missing bearer` — a message from a
 * different product, with no mention of `codex login`. Nothing here read the
 * credential file on purpose: Codex accepts a ChatGPT login, an API key via
 * `codex login --with-api-key`, and honours its own CODEX_HOME, so the only
 * answer that is right in every case is the one the CLI itself gives.
 *
 * `codex login status` prints "Logged in using ChatGPT" / "Logged in using an
 * API key" and exits 0, or "Not logged in" and exits 1 (codex-cli 0.152.1,
 * checked both ways). Anything else — no such subcommand on an older build,
 * a spawn failure, a hang — is `unknown`, and doctor treats unknown as "could
 * not tell", never as a failure, so a Codex build this cannot read does not
 * fail a working install.
 *
 * Only Codex today. The other harnesses have no equivalent subcommand this
 * tool has verified; guessing at their credential files would reintroduce the
 * false-negative risk this avoids.
 */

import spawn from "cross-spawn";

export type LoginState = "logged_in" | "logged_out" | "unknown";

export function codexLoginState(command: string, timeoutMs = 15_000): Promise<LoginState> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state: LoginState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["login", "status"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve("unknown");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish("unknown");
    }, timeoutMs);
    timer.unref();
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => finish("unknown"));
    child.on("close", (code) => {
      if (code === 0) finish("logged_in");
      else if (/not logged in/i.test(output)) finish("logged_out");
      else finish("unknown");
    });
  });
}
