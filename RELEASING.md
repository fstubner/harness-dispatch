# Releasing

Maintainer procedure. It follows `.github/workflows/publish.yml`, which does the
publishing, and the gate in `scripts/check-acceptance.mjs`.

## Cadence

At most one release a day. Finished work waits under `[Unreleased]` in
[CHANGELOG.md](CHANGELOG.md); a finished fix is not a reason to cut a version. Check the
date of the last release (`git tag`, or the newest dated heading in the changelog)
before starting. The exception is a severe defect in what is already published.

## Steps

1. **Pick the version.** The project is pre-1.0, so minor versions can change
   behaviour and patch versions are fixes.
2. **Bump it in three places**, to the same value:
   - `package.json`
   - `package-lock.json` (`npm version <x.y.z> --no-git-tag-version` updates both)
   - `plugin/.claude-plugin/plugin.json`

   A test fails if `plugin.json` differs from `package.json`.
3. **Date the changelog.** Rename `## [Unreleased]` to `## [x.y.z] — YYYY-MM-DD` and
   add a fresh empty `## [Unreleased]` above it. The gate refuses a version with no
   `## [x.y.z]` heading.
4. **Run an acceptance pass** against that exact build, from a separate context from
   the one that wrote the code, and record it in the `acceptance` directory as
   `<version>.md`, for example the 0.12.0 record. The format,
   including the one live dispatch every pass makes, is in
   [acceptance/README.md](acceptance/README.md). A `BLOCK` verdict, a missing record,
   or a record naming a different version fails the gate; `CONDITIONAL` passes.
5. **Merge to `main`.** Put steps 2 to 4 in one `chore(release): x.y.z` pull request
   and merge it. The gate also requires the tagged commit to be on `origin/main`.
6. **Run the checks locally** if you want to see them before CI does:

   ```bash
   npm ci
   npm run check
   npm run smoke
   node scripts/check-acceptance.mjs x.y.z
   node scripts/verify-tarball.mjs
   ```

7. **Tag and push the tag** from the merged commit:

   ```bash
   git tag vx.y.z
   git push origin vx.y.z
   ```

## What the tag does

Pushing a `v*` tag runs `publish.yml`:

1. `verify` runs the acceptance gate first (record, changelog heading, commit on
   `main`), then installs, stamps the version from the tag, runs `npm run check` and
   `npm run smoke`, packs the package, installs the tarball into a scratch prefix and
   runs it (`--version`, `doctor`, an MCP handshake). The tarball is uploaded as an
   artifact.
2. `publish-npm` publishes exactly that tarball to npm with provenance, through npm
   trusted publishing (OIDC). It has no checkout and no stored npm token. If the
   version is already on npm it does nothing.
3. `draft-release` creates a **draft** GitHub release with placeholder notes. If a
   release for the tag already exists, it leaves it alone.

## After the tag: write the notes

The draft is the review gate and the workflow does not publish it. Open the draft and
replace the placeholder with notes written by hand: a sentence or two on what the
release is for, then what a user will notice, what to know before upgrading, and the
notable fixes. Do not paste the changelog section; it is the full record and reads as
a wall of text in a release body. Keep one line per paragraph or bullet, because a
release body renders every newline as a line break. When the notes are done, publish
the release yourself.

## If the workflow fails

A failure in `verify` publishes nothing. Fix it on `main`, delete the tag
(`git push origin :refs/tags/vx.y.z` and `git tag -d vx.y.z`), and tag again. Once a
version is on npm it cannot be reused; ship the fix as the next version.
