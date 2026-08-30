/**
 * The redaction that wasn't.
 *
 * `redactEndpointHost` replaced the hostname by assigning to `url.hostname`.
 * The WHATWG URL setter silently rejects a value containing `<` and `>`, so
 * the assignment did nothing and every "redacted" string was its input
 * verbatim — while three call sites, one of them commented "safe to paste into
 * a bug report", presented the result as scrubbed. An acceptance pass measured
 * a real endpoint and an API key embedded in a query string reaching both a
 * dispatch error and the dispatch log.
 *
 * It shipped inert because nothing tested it. These are the properties the
 * function claims, asserted on its output rather than on its intent.
 */

import { describe, expect, it } from "vitest";

import { redactEndpointHost, scrubEndpointSecrets } from "../src/status.js";

describe("redactEndpointHost", () => {
  it("actually removes the hostname", () => {
    const out = redactEndpointHost("https://api.secret-internal.example.com/v1");
    expect(out).not.toContain("secret-internal");
    expect(out).toBe("https://<endpoint-host>/v1");
  });

  it("keeps the scheme, port and path, which carry the diagnostic value", () => {
    expect(redactEndpointHost("http://box.internal:11434/v1")).toBe(
      "http://<endpoint-host>:11434/v1",
    );
  });

  it.each([
    ["a query string", "https://api.example.com/v1?key=SECRETKEY123", "SECRETKEY123"],
    ["userinfo", "https://user:hunter2@api.example.com/v1", "hunter2"],
    ["a fragment", "https://api.example.com/v1#token=abc123", "abc123"],
  ])("drops %s, which can carry a credential", (_label, input, secret) => {
    expect(redactEndpointHost(input)).not.toContain(secret);
  });

  it("drops credentials even on loopback, where the host is kept", () => {
    // The host tells the reader something useful and discloses nothing, so it
    // stays. A key in the URL is a credential wherever the host points, and
    // the original returned loopback URLs completely untouched.
    const out = redactEndpointHost("http://localhost:1234/v1?api_key=SECRET");
    expect(out).toContain("localhost");
    expect(out).not.toContain("SECRET");
  });

  it.each(["localhost", "127.0.0.1"])("leaves the %s hostname intact", (host) => {
    expect(redactEndpointHost(`http://${host}:1234/v1`)).toContain(host);
  });

  it("degrades to a placeholder rather than echoing an unparseable value", () => {
    expect(redactEndpointHost("not a url at all")).toBe("<endpoint>");
  });
});

/**
 * The STRUCTURED payload must be redacted too, not just the text rendering.
 *
 * `redactEndpointHost` lives in status.ts and was wired into the usage hint and
 * the error paths, and never into `buildStatus`'s output — so `status --json`
 * and the `harness-dispatch://status.json` MCP resource emitted `base_url`
 * verbatim, twice per route. An acceptance pass measured a key embedded in the
 * URL reaching both. That resource is one this server's own instructions tell
 * agents to read, so the credential lands in an agent's context.
 *
 * An earlier pass recorded "endpoint redaction — verified" having checked only
 * the text surface. One value, two renderings, one of them fixed.
 */
describe("status payload redaction", () => {
  it("redacts base_url everywhere it appears in the JSON", async () => {
    const { buildStatus } = await import("../src/status.js");
    const secret = "SUPERSECRET123";
    const config = {
      services: {
        leaky: {
          name: "leaky",
          enabled: true,
          type: "openai_compatible" as const,
          baseUrl: `https://api.internal.example.com/v1?key=${secret}`,
          endpointMode: "direct_openai_compatible",
          model: "m",
          tier: 3,
          weight: 1,
          cliCapability: 1,
          capabilities: { execute: 1, plan: 1, review: 1 },
          escalateOn: [],
          maxOutputTokens: 100,
          maxInputTokens: 100,
          provider: "local" as const,
          surface: "local_endpoint" as const,
          authSource: "local_network" as const,
          billingKind: "local_compute" as const,
          paidUsagePossible: false,
          billingConfidence: "documented" as const,
        },
      },
    };

    const quota = { fullStatus: async () => ({}), getQuotaScore: async () => 1 };
    const router = {
      circuitBreakerStatus: () => ({}),
      breakerStateUnreadable: () => [],
      pickService: () => undefined,
      getBreaker: () => undefined,
    };
    const leaderboard = { getQualityScore: async () => ({ qualityScore: 0.85 }) };
    const status = await buildStatus(
      config as never,
      {} as never,
      quota as never,
      router as never,
      leaderboard as never,
    );
    const serialised = JSON.stringify(status);
    expect(serialised, "the credential survived into the status payload").not.toContain(secret);
    expect(serialised, "the endpoint host survived").not.toContain("api.internal.example.com");
    expect(serialised).toContain("<endpoint-host>");
  });
});

describe("idempotence", () => {
  it("returns an already-redacted string unchanged", () => {
    // Redacting twice used to be WORSE than redacting once: the placeholder
    // is not a parseable URL, so the second call fell to the catch and
    // returned the bare `<endpoint>`, discarding the scheme, port and path.
    // An acceptance pass found that as a regression in usage's model hint.
    const once = redactEndpointHost("https://api.example.com:8443/v1");
    expect(redactEndpointHost(once)).toBe(once);
    expect(once).toBe("https://<endpoint-host>:8443/v1");
  });
});

describe("scrubEndpointSecrets", () => {
  const BASE = "https://user:pw@api.secret-internal.example.com:8443/v1?key=SECRETKEY123";

  it("removes a credential that arrived inside text this code did not write", () => {
    // redactEndpointHost only cleans a URL a caller hands it. undici embeds
    // the URL it was given in its own message, so wrapping that message and
    // appending a redacted URL beside it put the raw credential and the
    // redacted form side by side — in the terminal AND in dispatches.jsonl,
    // under a doc comment promising it was safe to paste into a bug report.
    const message =
      "Request cannot be constructed from a URL that includes credentials: " +
      `${BASE}/v1/chat/completions`;
    const out = scrubEndpointSecrets(message, BASE);
    expect(out).not.toContain("SECRETKEY123");
    expect(out).not.toContain("pw@");
    expect(out).not.toContain("api.secret-internal.example.com");
  });

  it("removes each credential-bearing part on its own, however the text assembled them", () => {
    const message = "host api.secret-internal.example.com rejected key SECRETKEY123 for user";
    const out = scrubEndpointSecrets(message, BASE);
    expect(out).not.toContain("SECRETKEY123");
    expect(out).not.toContain("api.secret-internal.example.com");
  });

  it("keeps a loopback host, which is diagnostic and not a secret", () => {
    // Same call redactEndpointHost makes. A key in the URL is still removed.
    const local = "http://127.0.0.1:11434/v1?key=LOCALSECRET";
    const out = scrubEndpointSecrets("connect ECONNREFUSED 127.0.0.1:11434 LOCALSECRET", local);
    expect(out).toContain("127.0.0.1");
    expect(out).not.toContain("LOCALSECRET");
  });

  it("leaves text that carries no part of the endpoint alone", () => {
    // The scrub must not fire on unrelated words — an over-eager replace would
    // corrupt the diagnosis it exists to preserve.
    const out = scrubEndpointSecrets("connection timed out after 120000ms", BASE);
    expect(out).toBe("connection timed out after 120000ms");
  });
});
