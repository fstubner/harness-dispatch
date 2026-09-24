import which from "which";

let warnedMissingSync = false;

export function commandAvailable(command: string): boolean {
  const candidate = which as typeof which & {
    sync?: (cmd: string, opts: { nothrow: true }) => string | null;
  };
  if (typeof candidate.sync !== "function") {
    // Fail CLOSED. Declaring every command available when the resolver is
    // unusable would get the route selected, spawned and failed — burning a
    // dispatch and a breaker failure instead of skipping it with a clear
    // "unavailable" reason. Not reachable with which@7, which does expose
    // .sync; this branch exists to survive an export-shape change.
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
