import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseVersion, pendingWarning, unreleasedEntries } from '../scripts/release-version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/release-version.mjs');

function validInput() {
  return {
    pkg: { version: '0.2.0' },
    lock: { version: '0.2.0', packages: { '': { version: '0.2.0' } } },
    readme: '# Cairnboard\n\n**Status:** early (0.2.0), under active development.\n',
    readmeTr: '# Cairnboard\n\n**Durum:** erken sürüm (0.2.0), geliştirme sürüyor.\n',
    schema: { cli: '0.2.0' },
    changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-15\n\n- Release.\n',
  };
}

test('repository version-bearing files agree', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const readmeTr = readFileSync(join(root, 'README.tr.md'), 'utf8');
  const schema = JSON.parse(readFileSync(join(root, 'test/fixtures/schema.json'), 'utf8'));
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

  assert.deepEqual(checkReleaseVersion({ pkg, lock, readme, readmeTr, schema, changelog }), []);
});

test('valid synthetic input produces no problems', () => {
  assert.deepEqual(checkReleaseVersion(validInput()), []);
});

test('rejects invalid or missing package.json version', () => {
  for (const version of [undefined, '', '0.2', 'v0.2.0', '0.2.0-beta.1', '01.2.3']) {
    const input = validInput();
    input.pkg = version === undefined ? {} : { version };
    const problems = checkReleaseVersion(input);
    assert.ok(problems.some((line) => line.includes('package.json:')), `expected problem for ${version}`);
  }
});

test('rejects package-lock.json root version mismatch', () => {
  const input = validInput();
  input.lock.version = '0.1.0';
  const problems = checkReleaseVersion(input);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /package-lock\.json: root version/);
});

test('rejects package-lock.json packages[""].version mismatch', () => {
  const input = validInput();
  input.lock.packages[''].version = '0.1.0';
  const problems = checkReleaseVersion(input);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /package-lock\.json: packages\[""\]\.version/);
});

test('rejects README.md missing or mismatched status line', () => {
  const missing = validInput();
  missing.readme = '# Cairnboard\n';
  assert.match(checkReleaseVersion(missing)[0], /README\.md: missing \*\*Status:\*\*/);

  const mismatch = validInput();
  mismatch.readme = '**Status:** early (0.1.0), under active development.\n';
  assert.match(checkReleaseVersion(mismatch)[0], /README\.md: status line does not contain \(0\.2\.0\)/);
});

test('rejects README.tr.md missing or mismatched status line', () => {
  const missing = validInput();
  missing.readmeTr = '# Cairnboard\n';
  assert.match(checkReleaseVersion(missing)[0], /README\.tr\.md: missing \*\*Durum:\*\*/);

  const mismatch = validInput();
  mismatch.readmeTr = '**Durum:** erken sürüm (0.1.0), geliştirme sürüyor.\n';
  assert.match(checkReleaseVersion(mismatch)[0], /README\.tr\.md: status line does not contain \(0\.2\.0\)/);
});

test('rejects test/fixtures/schema.json cli mismatch', () => {
  const input = validInput();
  input.schema.cli = '0.1.0';
  const problems = checkReleaseVersion(input);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /test\/fixtures\/schema\.json: cli/);
});

test('rejects CHANGELOG.md without [Unreleased] first', () => {
  const input = validInput();
  input.changelog = '# Changelog\n\n## [0.2.0] - 2026-11-15\n\n## [Unreleased]\n';
  const problems = checkReleaseVersion(input);
  assert.ok(problems.some((line) => line.includes('first ## heading must be "## [Unreleased]"')));
});

test('rejects CHANGELOG.md without a versioned heading after [Unreleased]', () => {
  const input = validInput();
  input.changelog = '# Changelog\n\n## [Unreleased]\n\n- Some change.\n';
  const problems = checkReleaseVersion(input);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing versioned heading/);
});

test('rejects CHANGELOG.md heading with wrong format, version, or invalid date', () => {
  const badFormat = validInput();
  badFormat.changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0]\n';
  assert.match(checkReleaseVersion(badFormat)[0], /must match "## \[X\.Y\.Z\] - YYYY-MM-DD"/);

  const badVersion = validInput();
  badVersion.changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-15\n';
  assert.match(checkReleaseVersion(badVersion)[0], /first release heading version is 0\.1\.0, expected 0\.2\.0/);

  const badDate = validInput();
  badDate.changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-02-30\n';
  assert.match(checkReleaseVersion(badDate)[0], /invalid release date "2026-02-30"/);
});

test('CLI prints version and exits 0 on repository', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('pending warning counts lines under [Unreleased] only', () => {
  const released = validInput().changelog;
  assert.equal(unreleasedEntries(released), 0);
  assert.equal(pendingWarning(released, '0.2.0'), null);
  const pending = released.replace('## [Unreleased]\n', '## [Unreleased]\n\n- One.\n  continued.\n- Two.\n');
  assert.equal(unreleasedEntries(pending), 2);
  assert.match(pendingWarning(pending, '0.2.0'),
    /^release pending: 2 CHANGELOG line\(s\) under \[Unreleased\] since 0\.2\.0/);
  assert.equal(unreleasedEntries(undefined), 0);
});

test('--pending never fails and stays quiet without unreleased lines', () => {
  const result = spawnSync(process.execPath, [script, '--pending'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
