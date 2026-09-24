import { describe, expect, it, vi } from "vitest";

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

describe("rotating while the token comes from the environment", () => {
  // HARNESS_DISPATCH_HTTP_TOKEN wins over the token file wherever the token is
  // read, so rotating the file changed nothing: `auth rotate` printed a new
  // token the server refused, while the old one — the one being rotated
  // because it leaked — kept working. Measured in an audit.
  it("refuses, naming the variable, and writes no token file", async () => {
    const { promises: fs } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { rotateHttpToken, tokenPath } = await import("../src/auth.js");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hr-auth-env-"));
    vi.stubEnv("HARNESS_DISPATCH_HOME", home);
    vi.stubEnv("HARNESS_DISPATCH_HTTP_TOKEN", "hr_value_from_env");
    try {
      await expect(rotateHttpToken()).rejects.toThrow(/HARNESS_DISPATCH_HTTP_TOKEN/);
      const wrote = await fs
        .stat(tokenPath())
        .then(() => true)
        .catch(() => false);
      expect(wrote, "a token file was written that nothing will ever read").toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
