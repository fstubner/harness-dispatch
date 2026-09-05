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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { buildStatus } from "../src/status.js";
import { clearActiveSecrets, redact } from "../src/redaction.js";
import { dispatchLogPath, logDispatch } from "../src/dispatch-log.js";
import { writeJson } from "../src/jobs/store.js";
import { jsonText } from "../src/mcp/tools.js";
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
} as const;


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
      `    base_url: https://user:${SECRETS.urlPassword}@second.example.invalid/v1/pk7d2f91ab34ce5077bd18e6a4?key=${SECRETS.urlQueryKey}`,
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

/**
 * A dispatch result carrying every planted credential, as a harness that
 * echoed its own key would produce.
 */
const leakyResult = () => ({
  output: `answer mentioning ${SECRETS.literalApiKey} inline`,
  service: "second_route",
  success: false,
  error: `auth failed: ${SECRETS.urlPassword} ${SECRETS.urlQueryKey} ${SECRETS.envApiKey}`,
  durationMs: 12,
});

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

  function expectClean(text: string, where: string): void {
    for (const [shape, value] of Object.entries(SECRETS)) {
      expect(text, `${shape} leaked into ${where}`).not.toContain(value);
    }
  }

  it("knows about every planted credential shape", () => {
    // If this fails the sweep below is passing for the wrong reason: it cannot
    // catch a secret the registry never knew about.
    for (const [shape, value] of Object.entries(SECRETS)) {
      expect(redact(value), `${shape} is not registered as a secret`).not.toContain(value);
    }
  });

  // Each case below drives the REAL sink and asserts on what that sink
  // actually emitted. The first version of this file called `redact()` on the
  // rendered payload before asserting, so it could not fail for a sink that
  // forgot to redact — an acceptance pass established that by reading, and
  // found an unredacted SSE sink shipping under a green suite. Nothing here
  // may call `redact` itself.

  it("sink: MCP tool result", () => {
    // Driven with a payload that DOES carry the credentials. Routed through a
    // real tool handler the value never appears, so that version of this case
    // passed with the sink sabotaged — proving nothing, which is the exact
    // defect being corrected here.
    const emitted = JSON.stringify(jsonText({ result: leakyResult() }));
    expect(emitted, "nothing was serialised").toContain("second_route");
    expectClean(emitted, "the MCP tool result");
  });

  it("sink: logs/dispatches.jsonl on disk", () => {
    const before = existsSync(dispatchLogPath())
      ? readFileSync(dispatchLogPath(), "utf8").length
      : 0;
    logDispatch("second_route", leakyResult() as never, undefined as never);
    const written = readFileSync(dispatchLogPath(), "utf8").slice(before);
    expect(written, "nothing was written, so this proved nothing").toContain("second_route");
    expectClean(written, "logs/dispatches.jsonl");
  });

  it("sink: job JSON written to disk", async () => {
    const file = path.join(dir, "result.json");
    await writeJson(file, { result: leakyResult() });
    const written = readFileSync(file, "utf8");
    expect(written, "nothing was written").toContain("second_route");
    expectClean(written, "a job JSON file");
  });

  it("sink: status payload", async () => {
    expectClean(JSON.stringify(await status(config), null, 2), "the status payload");
  });

  it("warns about a credential in a base_url path instead of guessing", () => {
    // Deliberately NOT redacted. A long path segment cannot be told from an
    // Azure deployment name by inspection, and the length heuristic that tried
    // made `gpt-4-turbo-preview` a redaction target — measured. Guessing wrong
    // corrupts output, which is worse than the disclosure. So the config says
    // so out loud and the user, who knows which it is, moves it to api_key.
    const warnings = (config.configWarnings ?? []).join(" ");
    expect(warnings).toContain("base_url's path contains a long opaque segment");
    expect(warnings).toContain("second_route");
  });

  it("leaves ordinary text alone", () => {
    // The cost of the guarantee must not be corrupted output — a false
    // positive silently mangles a harness's real answer, which is worse than
    // the leak it prevents. An acceptance pass measured exactly that when the
    // registry collected every ${VAR}, not only credential fields.
    const answer =
      "The fix is in src/router.ts; run `npm run check`. Model gpt-5.6-terra on first_route.";
    expect(redact(answer)).toBe(answer);
  });
});

/**
 * Every sink, and which of them a behavioural test can actually prove.
 *
 * A verification pass sabotaged all nine redaction call sites one at a time.
 * Four failed exactly one case each; five shipped green — including
 * `sendJson`, whose own comment calls itself a sink, and the `jobs/run.ts`
 * catch path added to fix round eight. My commit and changelog both said
 * removing any one sink's redaction fails that sink's case. That was wrong,
 * and it is the same overclaim this whole sequence has been about.
 *
 * The five are not dead code. They are structural guards: no currently
 * reachable input puts a credential through them, because something upstream
 * already redacted it — the buffered HTTP path serves `result.output` read
 * back from `result.json`, which `writeJson` cleaned on the way to disk. That
 * is the design working, and it is exactly why the guards must stay: the point
 * of scrubbing at sinks rather than at sites is that a NEW path reaching one
 * is covered without anyone thinking about it.
 *
 * So they get the check that fits what they are. A behavioural test cannot
 * fail for them without a reachable secret, and inventing one would be a test
 * that passes for the wrong reason — the defect that started this. Instead
 * this asserts the call is still there. It catches a removal, which is the
 * real risk for a guard, and it names every sink in one list so a new one has
 * somewhere to be added.
 */
describe("every egress sink still redacts", () => {
  const SINK_SITES: Array<{ file: string; needle: string; proven: boolean }> = [
    { file: "src/mcp/tools.ts", needle: "redact(JSON.stringify(value, null, 2))", proven: true },
    { file: "src/dispatch-log.ts", needle: "redact(JSON.stringify(buildDispatchLogEntry", proven: true },
    { file: "src/jobs/store.ts", needle: "redact(JSON.stringify(value, null, 2))", proven: true },
    { file: "src/http/server.ts", needle: "redact(JSON.stringify(payload))", proven: true },
    // Structural guards: no reachable input carries a secret here today.
    { file: "src/http/server.ts", needle: "redact(JSON.stringify(body, null, 2))", proven: false },
    { file: "src/mcp/resources.ts", needle: "redact(renderStatusText(status))", proven: false },
    { file: "src/mcp/resources.ts", needle: "redact(JSON.stringify(status, null, 2))", proven: false },
    { file: "src/jobs/run.ts", needle: "redact(result.output)", proven: false },
    { file: "src/jobs/run.ts", needle: "redact(result.error ?? \"\")", proven: false },
    { file: "src/jobs/run.ts", needle: "redact(message)", proven: false },
    { file: "src/jobs/run.ts", needle: "redact(event.chunk)", proven: false },
    { file: "src/observability/spans.ts", needle: "redact(e.message)", proven: false },
  ];

  for (const site of SINK_SITES) {
    it(`${site.file}: ${site.needle.slice(0, 44)}${site.proven ? "" : " (guard)"}`, () => {
      const source = readFileSync(path.join(process.cwd(), site.file), "utf8");
      expect(
        source,
        `${site.file} no longer redacts at this sink — if that is deliberate, ` +
          `remove it from SINK_SITES and say why in the same commit`,
      ).toContain(site.needle);
    });
  }

  it("names the sinks a behavioural case actually proves", () => {
    // Kept honest against the sabotage matrix rather than against intent: if a
    // guard gains a reachable secret input, write the behavioural case and
    // flip it to proven, rather than leaving this list flattering.
    expect(SINK_SITES.filter((s) => s.proven)).toHaveLength(4);
  });
});
