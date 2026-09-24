/**
 * Asks a harness CLI whether it is logged in.
 *
 * Without this, a route reports `ok` on routes, billing and safety while the
 * CLI has never been logged in, and the first dispatch fails with a raw
 * OpenAI `401 Unauthorized ... Missing bearer` that never mentions
 * `codex login`. The credential file is deliberately not read: Codex accepts
 * a ChatGPT login, an API key via `codex login --with-api-key`, and honours
 * its own CODEX_HOME, so only the CLI's own answer is right in every case.
 *
 * `codex login status` prints "Logged in using ChatGPT" / "Logged in using an
 * API key" and exits 0, or "Not logged in" and exits 1 (codex-cli 0.152.1).
 * Anything else — no such subcommand on an older build, a spawn failure, a
 * hang — is `unknown`, which doctor treats as "could not tell" rather than a
 * failure, so a Codex build this cannot read does not fail a working install.
 *
 * Only Codex: the other harnesses have no verified equivalent subcommand, and
 * guessing at their credential files would risk false negatives.
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
      finish("unknown");
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
      // Exit 0 alone is not enough: a Codex build without the `login status`
      // subcommand prints its usage text and exits 0. Both halves must agree —
      // a successful exit AND text that says so.
      if (code === 0 && /logged in/i.test(output)) finish("logged_in");
      else if (/not logged in/i.test(output)) finish("logged_out");
      else finish("unknown");
    });
  });
}
