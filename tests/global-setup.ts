/**
 * Make every way of running the suite test the CURRENT source.
 *
 * About twenty tests spawn the built artifact (dist/bin.js, dist/job-runner.js).
 * Only `npm test` used to build first; `npm run test:unit`, `test:watch`,
 * `test:parity` and a bare `vitest` ran against whatever dist/ happened to be
 * there — a stale one passed old code under new tests, a missing one skipped
 * the tests that needed it and reported green. This builds when dist/ is
 * missing or older than src/ and does nothing when it is fresh.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--if-stale"], {
    cwd: root,
    stdio: "inherit",
  });
}
