/**
 * Environment-name handling that decides what a delegate may see. The platform
 * is a parameter, so the Windows behaviour is checked on every machine.
 */

import { describe, expect, it } from "vitest";

import { mergeEnv, sameEnvName } from "../src/dispatchers/shared/env-names.js";

describe("sameEnvName", () => {
  it("ignores case on win32 only", () => {
    expect(sameEnvName("groq_api_key", "GROQ_API_KEY", "win32")).toBe(true);
    expect(sameEnvName("groq_api_key", "GROQ_API_KEY", "linux")).toBe(false);
    expect(sameEnvName("GROQ_API_KEY", "GROQ_API_KEY", "linux")).toBe(true);
  });
});

describe("mergeEnv", () => {
  it("on win32, a blank replaces the differently-cased entry instead of sitting beside it", () => {
    const merged = mergeEnv({ GROQ_API_KEY: "secret", PATH: "p" }, { groq_api_key: "" }, "win32");
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "groq_api_key")).toEqual([
      "groq_api_key",
    ]);
    expect(merged["groq_api_key"]).toBe("");
    expect(merged["PATH"]).toBe("p");
  });

  it("elsewhere, differently-cased names are different variables and both stay", () => {
    const merged = mergeEnv({ GROQ_API_KEY: "secret" }, { groq_api_key: "" }, "linux");
    expect(merged["GROQ_API_KEY"]).toBe("secret");
    expect(merged["groq_api_key"]).toBe("");
  });
});
