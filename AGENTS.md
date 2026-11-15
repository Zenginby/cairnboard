# Agent instructions

- First command in a fresh clone: `npm run hooks:install`.
- Run `npm test` before every commit; it must pass.
- Code, file, data-key and command names are English.
- Never write private project, person, organisation or machine names into files, commit messages or PR descriptions.
- Never read or copy files from other repositories on this machine; write everything here from the spec you were given.
- Do not push, merge, rebase, reset or open pull requests unless the maintainer asks.
- A UI screen is built from `DESIGN.md` plus its frozen prototype (`design/README.md` lists them and the stage each belongs to); do not copy prototype code and do not edit prototypes except to fix a `npm run design:check` finding.
- Before any UI work, read `DESIGN.md`; never hand-write colors, spacing, radii, durations or easings; run `npm run design:build` after editing `DESIGN.md` or `design/themes/`.
- Every user-visible change adds a line under `## [Unreleased]` in `CHANGELOG.md` in the same commit.
- Releases follow `docs/releasing.md`.
