/** `configure`: generate or preview config.yaml. */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { billingIsBlocked, buildRouteBilling } from "../billing.js";
import { effectiveSafetyProfile } from "../safety.js";
import { configToYaml, isUneditedGenerated, stampGenerated } from "../configure-yaml.js";
import { desiredEntry, launchCommand } from "../client-register.js";
import { userConfigPath } from "../state-dir.js";
import { cmdConnect } from "./connect.js";

export async function cmdConfigure(
  configPath: string | undefined,
  opts: {
    print: boolean;
    yes: boolean;
    force: boolean;
    noClients: boolean;
    clients?: string | undefined;
  },
): Promise<number> {
  // configure's --config names where it will WRITE, so a path that does not
  // exist yet is the normal first-run case, not a typo.
  const target = configPath ?? userConfigPath();
  // A file configure wrote and nobody edited is regenerated from a fresh
  // detection rather than loaded: loading it would make it authoritative and
  // hide the harness installed since — the reason the user is re-running.
  // Anything else on disk is the user's, loaded so its settings migrate, and
  // guarded below.
  const existing = existsSync(target) ? await fs.readFile(target, "utf-8") : undefined;
  const regenerate = existing !== undefined && isUneditedGenerated(existing);
  const config = await loadConfig(regenerate ? undefined : configPath, { allowMissing: true });
  const routeCount = Object.keys(config.services).length;

  if (opts.print) {
    // Preview goes to a terminal and, routinely, into a bug report — a
    // literal key with no ${VAR} to restore is redacted rather than echoed.
    const preview = configToYaml(config, { redactLiterals: true });
    process.stdout.write(preview);
    const keyRedacted = Object.values(config.services).some(
      (svc) =>
        svc.apiKey !== undefined &&
        svc.apiKey !== "" &&
        config.envRefs?.get(svc.apiKey) === undefined &&
        config.apiKeyRefs?.get(svc.name) === undefined,
    );
    // The note has to name everything it redacted: a base_url can carry a
    // password too, and a note speaking only for the api_key would imply the
    // rest of the preview was sanitised when it was not.
    const urlRedacted = Object.values(config.services).some((svc) => {
      if (svc.baseUrl === undefined || svc.baseUrl === "") return false;
      if (config.envRefs?.get(svc.baseUrl) !== undefined) return false;
      try {
        const url = new URL(svc.baseUrl);
        return (
          url.password !== "" || url.username !== "" || [...url.searchParams.keys()].length > 0
        );
      } catch {
        return true;
      }
    });
    if (keyRedacted || urlRedacted) {
      const what = [
        keyRedacted ? "api_key values" : undefined,
        urlRedacted ? "credential-bearing parts of base_url" : undefined,
      ]
        .filter(Boolean)
        .join(" and ");
      process.stderr.write(
        `note: ${what} are literals in the source config and were redacted in this ` +
          "preview. Move them to environment variables — this output is not a drop-in " +
          "replacement for that file until you do.\n",
      );
    }
    return 0;
  }

  const yamlText = configToYaml(config, { redactLiterals: false });

  // "Detected" is only true when detection ran. Over an edited file that lists
  // its own routes it does not — the file is authoritative — and claiming a
  // detection there hides a harness on PATH that is not in the output.
  const plural = routeCount === 1 ? "" : "s";
  process.stdout.write(
    config.detectionRan === false
      ? `${routeCount} route${plural} from ${path.resolve(configPath ?? target)} — detection did not run, ` +
          "because this file lists its own routes. To merge harnesses installed since, add " +
          "`detect: true` to it; to start over from a fresh detection, delete it first.\n"
      : `Detected ${routeCount} harness route${plural}.\n`,
  );
  for (const [name, svc] of Object.entries(config.services)) {
    process.stdout.write(
      `- ${name}: harness=${svc.harness ?? name} billing=${buildRouteBilling(svc).kind} safety=${effectiveSafetyProfile(svc)} model=${
        svc.model ?? svc.leaderboardModel ?? "unknown"
      }\n`,
    );
  }

  const blocked = Object.entries(config.services)
    .filter(([, svc]) => svc.enabled && billingIsBlocked(buildRouteBilling(svc)))
    .map(([name]) => name);
  if (blocked.length > 0) {
    process.stdout.write(
      `\nBlocked until you opt in: ${blocked.join(", ")}. These routes can incur paid\n` +
        "usage (metered API, unknown billing, or subscription overage), so they are\n" +
        "skipped until you set allow_paid_usage: true on each route you trust.\n" +
        "Verify with: harness-dispatch doctor --live\n",
    );
  }

  if (config.configWarnings && config.configWarnings.length > 0) {
    process.stdout.write(
      `\nIgnored config entries (${config.configWarnings.length}) — these had no effect:\n`,
    );
    for (const warning of config.configWarnings) {
      process.stdout.write(`- ${warning}\n`);
    }
  }

  if (regenerate) {
    process.stdout.write(
      `\n${path.resolve(target)} is unedited configure output — ` +
        `${opts.yes ? "regenerating it from this detection" : "--yes will regenerate it from this detection"}.\n`,
    );
  }
  if (!opts.yes) {
    process.stdout.write(
      `\nNo files written. Re-run with --yes to write ${target}, or use --print to inspect YAML.\n`,
    );
    process.stdout.write(
      "After writing config, connect agents by adding the harness-dispatch MCP snippet to the agent you use.\n",
    );
    return 0;
  }

  // Guard ANY existing file, however the path was supplied. Overwriting a
  // hand-written config is not recoverable, so it takes an explicit --force
  // rather than an accident of which flag was used.
  if (existsSync(target) && !opts.force && !regenerate) {
    process.stderr.write(
      `configure: ${target} already exists and would be overwritten.\n` +
        "Use --print to inspect the generated YAML, --config <other-path> to write\n" +
        "elsewhere, or --force to overwrite it deliberately.\n",
    );
    return 1;
  }
  // 0600, because this file can contain a LITERAL api_key: `apiKeyForYaml`
  // deliberately preserves one rather than replacing it with a `${VAR}`
  // reference, so `configure` can write a real credential to disk. POSIX only;
  // Windows ignores the mode.
  //
  // Applied on create only: `writeFile`'s mode does not change an existing
  // file's permissions, so re-running `configure` will not silently tighten a
  // file the user deliberately made group-readable.
  // The default target lives in the state directory, which a first run has
  // not created yet. Same mode the rest of the state dir gets.
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, stampGenerated(yamlText), { encoding: "utf-8", mode: 0o600 });
  const absoluteTarget = path.resolve(target);
  process.stdout.write(`Wrote ${absoluteTarget}.\n`);

  // Offer to register with clients rather than ending setup with JSON to
  // paste: nobody owns a pasted entry, and the paths in it go stale silently.
  if (!opts.noClients) {
    process.stdout.write("\n");
    return cmdConnect(configPath, {
      clients: opts.clients,
      remove: false,
      yes: false,
      force: false,
      // Setup registers the installed package. A checkout entry is a
      // deliberate choice made by someone who knows they have a checkout, not
      // something to infer during first-run setup.
      dev: false,
    });
  }

  process.stdout.write(
    "\nMCP snippet (uses an absolute --config path so it resolves correctly no matter what\n" +
      "directory the MCP client launches from — a relative path or none at all silently\n" +
      "falls back to the shipped defaults, ignoring every edit you make to this file):\n",
  );
  // The SAME entry `connect` writes, built by the same function — otherwise a
  // pasted snippet does not match what `connect` recognises, and `connect
  // --remove` treats it as a hand-edited entry it must not touch.
  printMcpSnippet(desiredEntry(absoluteTarget, launchCommand()));
  process.stdout.write("Or let `harness-dispatch connect` write it for you.\n");
  return 0;
}

/** The entry, in the shape a client's config file wants it pasted. */
export function printMcpSnippet(entry: { command: string; args: string[] } | undefined): void {
  if (entry === undefined) return;
  process.stdout.write(
    JSON.stringify({ mcpServers: { "harness-dispatch": entry } }, null, 2) + "\n",
  );
}
