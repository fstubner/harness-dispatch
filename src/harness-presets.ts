/**
 * The shipped harness presets: what `config.default.yaml` says a built-in
 * harness is, and how a route of that harness behaves before the user
 * changes anything.
 *
 * WHY THIS IS ITS OWN MODULE. "A harness preset" had no home. It was a
 * protocol block in YAML, loaded and parsed inside config.ts, interpreted by
 * dispatchers/generic-cli.ts, read again by mcp/dispatcher-factory.ts to
 * collect API-key env vars, and asserted by four per-harness test files that
 * each imported PROTOCOL_PRESETS and drove the generic dispatcher. A
 * co-change check over 300 commits reported the result as shotgun surgery:
 * ten files moving together across six directories, because every change to
 * a shipped protocol had to touch all of them.
 *
 * Nothing here loads a user's config; config.ts owns that and imports this.
 * The dependency runs one way — presets know nothing about the file the user
 * wrote, which is what keeps the parse order honest.
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
 * `harness: generic` is not a harness definition — it's the escape hatch a
 * user's own entry selects when adding a wholly new CLI, so its "defaults"
 * are parser fallbacks, not example config. Billing is unknown/blocked until
 * the operator classifies it, since there's no way to know an arbitrary
 * CLI's real billing model. Command is empty so it can never be
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
 * module — same "walk up" approach as leaderboard.ts's benchmark file, so
 * it works whether this is running compiled (dist/) or via tsx (src/). This
 * is a DIFFERENT file from a user's own config.yaml (never tracked, may
 * hold secrets/local overrides) — separating them means a package update to
 * the shipped defaults never collides with or gets clobbered by a user's
 * live instance, and vice versa.
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
 * Parse one `clis:` entry of the shipped config into CliDefaults. Uses the
 * exact same field parsers (str/num/int/capsFrom/parseProtocolFields/...)
 * as a user's own `clis:` entry — the shipped file IS a config.yaml, parsed
 * the same way, not a special hardcoded path or bespoke shape.
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
      // The shipped defaults are the FOURTH consumer of the shared field
      // contract, and were the one still hand-writing its own list. It had
      // already drifted: `thinking_level` on a shipped harness entry was
      // dropped on the floor, while route-fields.ts reads `d.thinkingLevel`
      // as the fallback for every user route of that harness — the exact
      // silent-drop shape the table exists to retire, one layer down.
      // Resolving through the table means a row added there works here too,
      // instead of needing to be remembered in a second place.
      ...resolveSharedRouteFields(raw),
      // This shape's own required identity fields, after the spread so they
      // win: the table cannot supply them, and `leaderboardModel` is a
      // required string here while the table leaves it optional.
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
 * Load the built-in harness defaults from the shipped config's `clis:` list
 * — the same shape as a `clis:` entry in a user's own config.yaml, keyed by
 * each entry's `harness:` value. Failure (missing/malformed file) degrades
 * to just the generic escape hatch — auto-detect simply finds nothing
 * built-in, rather than crashing the whole router; a user's own
 * `clis:`/`services:` entries are unaffected either way.
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
      // Shipped-config warnings indicate a packaging/build problem, not a
      // user config mistake — surface loudly rather than folding into
      // configWarnings (which a user would reasonably assume is about
      // their own file).
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
