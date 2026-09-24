/**
 * The shipped harness presets: what `config.default.yaml` says a built-in
 * harness is, and how a route of that harness behaves before the user
 * changes anything.
 *
 * A harness preset is read by config.ts, dispatchers/generic-cli.ts,
 * mcp/dispatcher-factory.ts and the per-harness tests; without one home, every
 * change to a shipped protocol is shotgun surgery across all of them.
 *
 * Nothing here loads a user's config; config.ts owns that and imports this.
 * The dependency runs one way, which keeps the parse order honest.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import {
  authSourceFrom,
  billingKindFrom,
  capsFrom,
  int,
  num,
  providerFrom,
  str,
  surfaceFrom,
} from "./config/coercions.js";
import { parseProtocolFields } from "./config/protocol.js";
import { resolveSharedRouteFields } from "./config/route-fields.js";
import type {
  AuthSource,
  BillingKind,
  BillingProvider,
  BillingSurface,
  CliProtocolConfig,
  SafetyProfile,
} from "./types.js";

export interface CliDefaults {
  command: string;
  harness: string;
  leaderboardModel: string;
  cliCapability: number;
  tier: number;
  thinkingLevel?: "low" | "medium" | "high";
  capabilities: { execute: number; plan: number; review: number };
  maxOutputTokens?: number;
  maxInputTokens?: number;
  provider: BillingProvider;
  surface: BillingSurface;
  authSource: AuthSource;
  billingKind?: BillingKind;
  paidUsagePossible?: boolean;
  /** Safety level this harness actually runs at (capability floor) — see ServiceConfig.effectiveSafety. */
  effectiveSafety?: SafetyProfile | Partial<Record<SafetyProfile, SafetyProfile>>;
  /** Operator-declared known-good model ids — see ServiceConfig.models. */
  models?: string[];
  /** Where this harness's real model catalog lives — see ServiceConfig.modelHint. */
  modelHint?: string;
  /** Default dispatch protocol for this harness — see the shipped config.default.yaml. */
  protocol?: CliProtocolConfig;
}

/**
 * `harness: generic` is the escape hatch for adding a wholly new CLI, so its
 * "defaults" are parser fallbacks, not example config. Billing is
 * unknown/blocked until the operator classifies it, since an arbitrary CLI's
 * real billing model is unknowable. Command is empty so it can never be
 * auto-detected; the user's entry must supply command + protocol.
 */
const GENERIC_DEFAULTS: CliDefaults = {
  command: "",
  harness: "generic",
  leaderboardModel: "",
  cliCapability: 1.0,
  tier: 3,
  capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
  provider: "custom",
  surface: "custom",
  authSource: "unknown",
  billingKind: "unknown",
  paidUsagePossible: true,
};

/**
 * Resolve the package's own bundled config.default.yaml relative to this
 * module — the same "walk up" as leaderboard.ts's benchmark file, so it works
 * compiled (dist/) or via tsx (src/). A DIFFERENT file from a user's own
 * config.yaml, so a package update to the shipped defaults never collides with
 * a user's live instance.
 */
function resolveShippedConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "config.default.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(here, "..", "config.default.yaml");
}

/**
 * Parse one `clis:` entry of the shipped config into CliDefaults, using the
 * same field parsers as a user's own `clis:` entry — the shipped file IS a
 * config.yaml, not a bespoke shape.
 */
function cliDefaultsFrom(raw: Record<string, unknown>, warnings: string[]): [string, CliDefaults] | undefined {
  const harness = str(raw.harness);
  if (!harness) return undefined;
  const protocolRaw = raw.protocol;
  const protocol =
    protocolRaw !== undefined
      ? parseProtocolFields(protocolRaw as Record<string, unknown>, `shipped config.default.yaml clis "${harness}"`, warnings, undefined)
      : undefined;
  const billingKind = billingKindFrom(raw.billing_kind);
  return [
    harness,
    {
      // Through the shared field table, so a row added there works here too.
      ...resolveSharedRouteFields(raw),
      // This shape's own required identity fields, after the spread so they
      // win: the table cannot supply them, and `leaderboardModel` is required
      // here while the table leaves it optional.
      command: str(raw.command) ?? "",
      harness,
      leaderboardModel: str(raw.leaderboard_model) ?? "",
      cliCapability: num(raw.cli_capability, 1.0),
      tier: int(raw.tier, 1),
      capabilities: capsFrom(raw.capabilities),
      provider: providerFrom(raw.provider) ?? "custom",
      surface: surfaceFrom(raw.surface) ?? "custom",
      authSource: authSourceFrom(raw.auth_source) ?? "unknown",
      ...(billingKind !== undefined ? { billingKind } : {}),
      ...(typeof raw.paid_usage_possible === "boolean" ? { paidUsagePossible: raw.paid_usage_possible } : {}),
      ...(protocol !== undefined ? { protocol } : {}),
    },
  ];
}

/**
 * Load the built-in harness defaults from the shipped config's `clis:` list,
 * keyed by each entry's `harness:` value. A missing or malformed file degrades
 * to just the generic escape hatch — auto-detect finds nothing built-in rather
 * than crashing the router, and a user's own entries are unaffected.
 */
function loadDefaultHarnesses(): Record<string, CliDefaults> {
  const warnings: string[] = [];
  const out: Record<string, CliDefaults> = { generic: GENERIC_DEFAULTS };
  try {
    const raw = yaml.load(readFileSync(resolveShippedConfigPath(), "utf8")) as {
      clis?: Record<string, unknown>[];
    };
    for (const entry of raw?.clis ?? []) {
      const parsed = cliDefaultsFrom(entry, warnings);
      if (parsed && parsed[0] !== "generic") out[parsed[0]] = parsed[1];
    }
    if (warnings.length > 0) {
      // A shipped-config warning is a packaging problem, not a user mistake,
      // so it does not belong in configWarnings — which a user would
      // reasonably read as being about their own file.
      for (const w of warnings) console.error(`harness-dispatch: shipped config.default.yaml: ${w}`);
    }
    return out;
  } catch (err) {
    console.error(
      `harness-dispatch: failed to load the package's shipped config.default.yaml (${err instanceof Error ? err.message : String(err)}) ` +
        "— no built-in harnesses will be available; your own clis:/services: entries are unaffected.",
    );
    return out;
  }
}

export const CLI_DEFAULTS: Record<string, CliDefaults> = loadDefaultHarnesses();

/** Named, selectable protocols — every harness in CLI_DEFAULTS that defines one, keyed by its harness name (see protocolFrom()'s string/`extends:` handling). */
export const PROTOCOL_PRESETS: Record<string, CliProtocolConfig> = Object.fromEntries(
  Object.entries(CLI_DEFAULTS)
    .filter((entry): entry is [string, CliDefaults & { protocol: CliProtocolConfig }] => entry[1].protocol !== undefined)
    .map(([name, defaults]) => [name, defaults.protocol]),
);
