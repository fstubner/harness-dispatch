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

import { redactEndpointHost } from "../src/status.js";

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
