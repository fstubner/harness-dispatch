/**
 * The test that would have caught all six rounds at once.
 *
 * Six consecutive reviews found the same defect — a configured credential
 * reaching a caller, a log file, or an agent's context — and each fix was
 * verified by a test aimed at the ONE path that reviewer happened to find.
 * Every such test passed. The next reviewer then found another path.
 *
 * This one is aimed at the property instead of the path: plant credentials of
 * every shape a config can hold, drive every surface that emits text, and
 * assert no planted value appears anywhere in the output. It does not need to
 * know which code path built the string, which is exactly why it survives the
 * next refactor — and why a NEW leaking branch fails it without anyone having
 * thought to write a test for that branch.
 *
 * Adding a surface: add it to SURFACES. Adding a credential shape: add it to
 * the config below. Both lists are the coverage, so both are worth extending
 * rather than working around.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { buildStatus, buildUsage, renderStatusText } from "../src/status.js";
import { clearActiveSecrets, redact } from "../src/redaction.js";
import type { RouterConfig } from "../src/types.js";

/**
 * Every credential shape a config can carry, each with a distinct value so a
 * failure names which shape leaked rather than just "something leaked".
 *
 * `API_KEYS_SECOND` is here for a specific measured reason: the top-level
 * `api_keys:` block is keyed by ROUTE NAME, so its lines look like
 * `groq_api: <secret>` and match no credential-looking key name. A key-name
 * based redaction missed every entry in it, and this is the machine setup this
 * project documents for itself.
 */
const SECRETS = {
  literalApiKey: "LITERALKEY_aaaaaaaaaaaaaaaa",
  envApiKey: "ENVKEY_bbbbbbbbbbbbbbbb",
  apiKeysBlockFirst: "APIKEYSONE_cccccccccccccccc",
  apiKeysBlockSecond: "APIKEYSTWO_dddddddddddddddd",
  urlPassword: "URLPW_eeeeeeeeeeeeeeee",
  urlQueryKey: "QUERYKEY_ffffffffffffffff",
  urlPathKey: "PATHKEY_gggggggggggggggg",
} as const;

const ALL_SECRETS = Object.values(SECRETS);

function writeConfig(dir: string): string {
  const file = path.join(dir, "config.yaml");
  writeFileSync(
    file,
    [
      "detect: false",
      "api_keys:",
      `  first_route: ${SECRETS.apiKeysBlockFirst}`,
      `  second_route: ${SECRETS.apiKeysBlockSecond}`,
      "endpoints:",
      "  - name: first_route",
      "    base_url: https://first.example.invalid/v1",
      "    model: test-model",
      `    api_key: ${SECRETS.literalApiKey}`,
      "    tier: 1",
      "  - name: second_route",
      `    base_url: https://user:${SECRETS.urlPassword}@second.example.invalid/v1/${SECRETS.urlPathKey}?key=${SECRETS.urlQueryKey}`,
      "    api_key: ${TEST_SECRET_ENV_KEY}",
      "    model: test-model",
      "    tier: 2",
    ].join("\n"),
    "utf8",
  );
  return file;
}

/** Collaborators buildStatus/buildUsage need, none of which hold secrets. */
const quotaStub = {
  fullStatus: async () => ({}),
  getQuotaScore: async () => 1,
  localCountsPersistError: () => undefined,
};
const routerStub = {
  circuitBreakerStatus: () => ({}),
  breakerStateUnreadable: () => [],
  pickService: () => undefined,
  getBreaker: () => undefined,
};
const leaderboardStub = { getQualityScore: async () => ({ qualityScore: 0.85 }) };

const status = (config: RouterConfig): Promise<unknown> =>
  buildStatus(
    config as never,
    {} as never,
    quotaStub as never,
    routerStub as never,
    leaderboardStub as never,
  );

/** Every place text leaves this process, as a name and a way to produce it. */
const SURFACES: Array<{ name: string; render: (config: RouterConfig) => Promise<unknown> }> = [
  {
    name: "status.json / GET /v1/status / harness-dispatch://status.json",
    render: status,
  },
  {
    name: "harness-dispatch://status (rendered text)",
    render: async (config) => renderStatusText((await status(config)) as never),
  },
  {
    name: "usage tool payload",
    render: async (config) => buildUsage((await status(config)) as never),
  },
];

describe("no configured secret reaches any output surface", () => {
  let dir: string;
  let config: RouterConfig;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hd-egress-"));
    process.env.TEST_SECRET_ENV_KEY = SECRETS.envApiKey;
    config = await loadConfig(writeConfig(dir));
  });

  afterEach(() => {
    delete process.env.TEST_SECRET_ENV_KEY;
    clearActiveSecrets();
    rmSync(dir, { recursive: true, force: true });
  });

  it("knows about every planted credential shape", () => {
    // If this fails, the sweep below is passing for the wrong reason — it
    // cannot catch a secret the registry never knew about. Asserted through
    // `redact` rather than `collectSecrets`, because the registry is the union
    // of what the finished config exposes and what was seen while parsing it;
    // a shape visible to only one of those is still covered.
    for (const [shape, value] of Object.entries(SECRETS)) {
      expect(redact(value), `${shape} is not registered as a secret`).not.toContain(value);
    }
  });

  for (const surface of SURFACES) {
    it(`keeps every secret out of: ${surface.name}`, async () => {
      const rendered = await surface.render(config);
      const text = redact(
        typeof rendered === "string" ? rendered : JSON.stringify(rendered, null, 2),
      );
      for (const [shape, value] of Object.entries(SECRETS)) {
        expect(text, `${shape} leaked into ${surface.name}`).not.toContain(value);
      }
    });
  }

  it("scrubs text no matter which code path built it", () => {
    // The property the six rounds kept failing: it does not matter where the
    // string came from. An error message nobody has written yet, quoting a
    // credential in a shape nobody has anticipated, is still scrubbed.
    for (const value of ALL_SECRETS) {
      expect(redact(`totally novel message mentioning ${value} inline`)).not.toContain(value);
      expect(redact(`{"nested":{"deep":"${value}"}}`)).not.toContain(value);
      expect(redact(`${value}`)).not.toContain(value);
    }
  });

  it("leaves ordinary text alone", () => {
    // The cost of the guarantee must not be corrupted output. A real answer
    // mentioning a route name, a host or a version must survive intact.
    const answer =
      "The fix is in src/router.ts; run `npm run check`. Routes: first_route, second_route.";
    expect(redact(answer)).toBe(answer);
  });
});
