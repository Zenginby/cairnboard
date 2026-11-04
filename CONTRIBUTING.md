# Contributing

- Run `npm run hooks:install` right after cloning; commits are scanned before they are created.
- Code, file, data-key and command names are English; user-facing text lives in `src/i18n/`.
- Tests: `npm test` (Node built-in test runner, no dependencies).
- Prototype acceptance: `npm run design:check` (requires a browser; see [Checking the prototypes](design/README.md#checking-the-prototypes)).
- Never put personal data (names, e-mail addresses, home paths, machine names) into files, commit messages,
  branch names or pull request descriptions. Use `example.com` and invented names in tests.
