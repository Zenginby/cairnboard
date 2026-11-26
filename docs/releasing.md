# Releasing Cairnboard

A release is not done until the GitHub Release exists. The `post-merge` hook warns while `## [Unreleased]` in
`CHANGELOG.md` still has lines.

## Choosing the version

Choose the version by the size of the change, judged from the `## [Unreleased]` lines as a whole:

| Change | Version | Example |
|---|---|---|
| Bug fix, small improvement, docs, security patch | patch (0.4.0 → 0.4.1) | the skill folder for the Antigravity CLI |
| A new feature or command users will notice | minor (0.4.0 → 0.5.0) | `npx cairnboard`, configurable fields |
| Before 1.0: a change that breaks the file format or the CLI | minor, with a `### Breaking` section in the CHANGELOG | a data format change |
| After 1.0: a breaking change | major | |

A small adjustment to an existing screen or command is a patch, not a feature.

## When to release

Release when changes have collected, not after every merge. Release promptly when a fix or security patch is
waiting for users. A release with any minor-level line is a minor release.

## Steps

1. Move the `## [Unreleased]` lines in `CHANGELOG.md` into a dated section `## [X.Y.Z] - YYYY-MM-DD`, keeping
   `## [Unreleased]` at the top.
2. Bump the version in all five version-bearing files:
   - Run `npm version X.Y.Z --no-git-tag-version` to update `package.json` and `package-lock.json`.
   - Update `README.md` (`**Status:**` line), `README.tr.md` (`**Durum:**` line), and `test/fixtures/schema.json`
     (`"cli"`).
   - Run `npm run release:verify` to confirm every file agrees.
3. Run `npm test` and verify it passes.
4. Run `npm run release:check` and verify it is clean before anything is pushed.
5. Commit the release with message `Release X.Y.Z`.
6. Create an annotated tag: `git tag -a vX.Y.Z -m "Release X.Y.Z"`.
7. Push the branch, then the tag (only with maintainer approval).
8. Pushing the tag starts the `Publish` workflow (`.github/workflows/publish.yml`). It checks that the tag is on
   `main`, matches the version files and is not yet on npm, builds the package, runs the pack smoke test and publishes
   with npm trusted publishing: no npm token is stored anywhere. Watch it with `gh run watch` and check the result
   with `npm view cairnboard version`. To publish an existing tag again after a failed run, start the workflow by hand:
   `gh workflow run publish.yml --ref main -f tag=vX.Y.Z`.

   The npm package trusts only this workflow file and the `npm` GitHub environment, which accepts `v*` tags and
   `main`. Renaming the file or the environment breaks publishing until the trusted publisher on npmjs.com is
   recreated.
   A tag push runs the workflow file from the tagged commit, so the `Release tags` ruleset lets only repository
   admins create, move or delete `v*` tags.

9. Create the GitHub Release (only with maintainer approval) with a short hand-written summary, not a CHANGELOG dump:
   `gh release create vX.Y.Z --verify-tag --title "Cairnboard X.Y.Z" --notes-file <file>`.
10. Finish with `npm run release:verify -- --tag --github`.
11. Review `ROADMAP.md`: remove what shipped (it is in the CHANGELOG now), update **Now** and **Next** and their
    issues, and set `Last reviewed` to the new version.
