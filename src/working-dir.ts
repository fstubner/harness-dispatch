/**
 * `workingDir` is effectively required on every dispatch entry point (MCP
 * tools, jobs, HTTP): when the caller omits it, the task runs in the router
 * server's own process cwd, almost never the project the caller means. That
 * silent wrong-directory execution was a review finding — this resolves the
 * value the same way everywhere and reports back whether it was defaulted so
 * callers can surface a visible warning instead of failing quietly.
 */

export interface ResolvedWorkingDir {
  workingDir: string;
  defaulted: boolean;
}

export function resolveWorkingDir(input: string | undefined): ResolvedWorkingDir {
  if (input !== undefined && input !== "") {
    return { workingDir: input, defaulted: false };
  }
  return { workingDir: process.cwd(), defaulted: true };
}

export function workingDirWarning(resolved: ResolvedWorkingDir): string | undefined {
  if (!resolved.defaulted) return undefined;
  return (
    `workingDir was not provided — ran in the router server's own directory ` +
    `(${resolved.workingDir}), which is almost certainly not the intended project. ` +
    `Pass an absolute workingDir on the next call.`
  );
}
