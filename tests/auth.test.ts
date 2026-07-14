import { describe, expect, it } from "vitest";

import { generateHttpToken, isAuthorized, maskToken } from "../src/auth.js";

describe("isAuthorized", () => {
  it("allows any request when no token is configured", () => {
    expect(isAuthorized(undefined, null)).toBe(true);
    expect(isAuthorized("Bearer anything", null)).toBe(true);
  });

  it("accepts the correct bearer token", () => {
    expect(isAuthorized("Bearer secret-token", "secret-token")).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(isAuthorized("Bearer secret-tokeX", "secret-token")).toBe(false);
  });

  it("rejects a wrong token of a different length", () => {
    expect(isAuthorized("Bearer short", "a-much-longer-secret-token")).toBe(false);
    expect(isAuthorized("Bearer a-much-longer-guess-token", "short")).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    expect(isAuthorized(undefined, "secret-token")).toBe(false);
  });

  it("rejects a header missing the Bearer prefix", () => {
    expect(isAuthorized("secret-token", "secret-token")).toBe(false);
  });

  it("uses the first value when the header arrives as an array", () => {
    expect(isAuthorized(["Bearer secret-token", "Bearer other"], "secret-token")).toBe(true);
  });

  it("rejects the empty string token as a header value", () => {
    expect(isAuthorized("", "secret-token")).toBe(false);
  });
});

describe("generateHttpToken / maskToken", () => {
  it("generates distinct hr_-prefixed tokens", () => {
    const a = generateHttpToken();
    const b = generateHttpToken();
    expect(a).toMatch(/^hr_/);
    expect(a).not.toBe(b);
  });

  it("masks the middle of a long token", () => {
    const masked = maskToken("hr_abcdefghijklmnopqrstuvwxyz");
    expect(masked.startsWith("hr_abc")).toBe(true);
    expect(masked.endsWith("uvwxyz")).toBe(true);
    expect(masked).toContain("...");
  });

  it("returns short tokens unmasked", () => {
    expect(maskToken("short")).toBe("short");
  });
});
