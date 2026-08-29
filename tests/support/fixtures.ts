/**
 * Fixtures built by the product's own generators, not by hand.
 *
 * WHY THIS EXISTS. Four separate tests in this repo asserted things about
 * inputs the product cannot produce, and two of them passed while the bug they
 * claimed to cover was live:
 *
 *  - `job-stale-0000000-aaaaaaaa` — no `newJobId()` produces that. The test
 *    asserted retention deletes it, and passed only because retention deleted
 *    everything. The moment retention learned to check ownership, the fixture
 *    stopped being a job at all.
 *  - workspace run directories ending in four characters where a real one ends
 *    in eight hex — so the reclamation sweep did not recognise them, and a test
 *    about reclamation was measuring something else.
 *  - `gone-project-deadbeef` — which matched the old name-shape guard *by
 *    accident*, so a test written to prove ownership proved nothing.
 *
 * The shared cause is 54 hand-written id strings and no builder. A fixture is
 * only evidence if it is the thing, so these call the real generators, and the
 * ones that must be deterministic are validated against the product's own
 * pattern at construction — a fixture that could never occur throws here
 * instead of silently changing what a test covers.
 *
 * `tests/fixture-shapes.test.ts` enforces the rule across the suite so this
 * cannot quietly come back.
 */

import { JOB_ID_RE, newJobId } from "../../src/jobs/store.js";
import { workspaceRootFor, workspaceRunId } from "../../src/workspaces.js";

/** The marker reclamation looks for. Never spell it out in a test. */
export const WORKSPACE_ROOT_MARKER = ".harness-dispatch-root";

/**
 * A real job id, from the real generator.
 *
 * Use this whenever the test does not care about the exact value — which is
 * most of the time.
 */
export function aJobId(): string {
  return newJobId();
}

/**
 * A job id that is stable across runs, for a test that needs to name the same
 * job twice, and still exactly the shape `newJobId()` produces.
 *
 * `seed` only varies the value; it cannot make it invalid. The assertion below
 * is the point of the whole module: if a change to `newJobId` ever moves the
 * shape, every fixture fails loudly at construction rather than each test
 * quietly starting to cover a case that no longer exists.
 */
export function fixedJobId(seed = 0): string {
  const stamp = 1_700_000_000_000 + seed;
  const suffix = seed.toString(16).padStart(8, "0").slice(-8);
  const id = `job-${stamp}-${suffix}`;
  if (!JOB_ID_RE.test(id)) {
    throw new Error(
      `fixtures: built an invalid job id (${id}). The generator's shape has changed; ` +
        `fix this builder rather than hand-writing ids in tests.`,
    );
  }
  return id;
}

/**
 * A run directory name as `prepareWorkspace` would create one, from the real
 * generator. Pass a route name only if the test asserts on it.
 */
export function aRunDirName(routeName = "alpha"): string {
  return workspaceRunId(routeName);
}

/**
 * The per-project workspace root for a project path — the directory
 * reclamation treats as one of ours.
 *
 * Honours `HARNESS_DISPATCH_WORKSPACES_DIR`, because it is the product's own
 * function, so a test that overrides the base gets the root the product would
 * actually use rather than one it guessed.
 */
export function workspaceRootPathFor(projectDir: string): string {
  return workspaceRootFor(projectDir);
}
