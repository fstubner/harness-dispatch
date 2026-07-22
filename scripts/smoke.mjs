import { TOOL_NAMES, VERSION } from "../dist/index.js";

if (!VERSION || typeof VERSION !== "string") {
  throw new Error("VERSION export is missing");
}

if (JSON.stringify(TOOL_NAMES) !== JSON.stringify(["dispatch", "job_status", "usage"])) {
  throw new Error(`Unexpected MCP tools: ${JSON.stringify(TOOL_NAMES)}`);
}

console.log(`harness-dispatch ${VERSION} smoke ok`);
