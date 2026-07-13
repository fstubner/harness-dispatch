import which from "which";

export function commandAvailable(command: string): boolean {
  const candidate = which as typeof which & {
    sync?: (cmd: string, opts: { nothrow: true }) => string | null;
  };
  if (typeof candidate.sync !== "function") return true;
  return Boolean(candidate.sync(command, { nothrow: true }));
}
