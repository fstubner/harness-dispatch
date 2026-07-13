import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  try {
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readPackageVersion();
