import which from "which";

let warnedMissingSync = false;

export function commandAvailable(command: string): boolean {
  const candidate = which as typeof which & {
    sync?: (cmd: string, opts: { nothrow: true }) => string | null;
  };
  if (typeof candidate.sync !== "function") {
    // Fail CLOSED. This previously returned true, declaring every command
    // available when the resolver was unusable: the route would be selected,
    // spawned, and fail — burning a dispatch and a breaker failure instead of
    // being skipped with a clear "unavailable" reason. Not currently
    // reachable (which@7 does expose .sync), but this branch exists precisely
    // to survive an export-shape change, and the package was moved across two
    // majors recently.
    if (!warnedMissingSync) {
      warnedMissingSync = true;
      console.error(
        "harness-dispatch: the 'which' package exposes no .sync() — cannot resolve " +
          "commands on PATH, so every CLI route will report unavailable.",
      );
    }
    return false;
  }
  return Boolean(candidate.sync(command, { nothrow: true }));
}
