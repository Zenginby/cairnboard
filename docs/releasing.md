# Releasing Cairnboard

A release is not done until the GitHub Release exists.

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
7. Push the branch and tag (only with maintainer approval).
8. Create the GitHub Release (only with maintainer approval) with a short hand-written summary, not a CHANGELOG dump:
   `gh release create vX.Y.Z --verify-tag --title "Cairnboard X.Y.Z" --notes-file <file>`.
9. Finish with `npm run release:verify -- --tag --github`.
