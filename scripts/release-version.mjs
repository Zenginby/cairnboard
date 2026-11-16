import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_HEADING_RE = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/;

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function checkReleaseVersion({ pkg, lock, readme, readmeTr, schema, changelog }) {
  const problems = [];
  const version = pkg?.version;
  const validVersion = typeof version === 'string' && SEMVER_RE.test(version);
  if (!validVersion) {
    problems.push(`package.json: invalid or missing version (${version ?? 'missing'})`);
  }

  if (validVersion) {
    if (lock?.version !== version) {
      problems.push(`package-lock.json: root version is ${lock?.version ?? 'missing'}, expected ${version}`);
    }
    if (lock?.packages?.['']?.version !== version) {
      const actual = lock?.packages?.['']?.version ?? 'missing';
      problems.push(`package-lock.json: packages[""].version is ${actual}, expected ${version}`);
    }

    const statusLine = typeof readme === 'string' ? /^\*\*Status:\*\*.*$/m.exec(readme)?.[0] : null;
    if (!statusLine) {
      problems.push('README.md: missing **Status:** line');
    } else if (!statusLine.includes(`(${version})`)) {
      problems.push(`README.md: status line does not contain (${version})`);
    }

    const statusLineTr = typeof readmeTr === 'string' ? /^\*\*Durum:\*\*.*$/m.exec(readmeTr)?.[0] : null;
    if (!statusLineTr) {
      problems.push('README.tr.md: missing **Durum:** line');
    } else if (!statusLineTr.includes(`(${version})`)) {
      problems.push(`README.tr.md: status line does not contain (${version})`);
    }

    if (schema?.cli !== version) {
      problems.push(`test/fixtures/schema.json: cli is ${schema?.cli ?? 'missing'}, expected ${version}`);
    }
  }

  if (typeof changelog !== 'string') {
    problems.push('CHANGELOG.md: missing content');
  } else {
    const headings = changelog.split(/\r?\n/).filter((line) => line.startsWith('## '));
    if (headings[0] !== '## [Unreleased]') {
      problems.push('CHANGELOG.md: first ## heading must be "## [Unreleased]"');
    }
    if (headings.length < 2) {
      problems.push('CHANGELOG.md: missing versioned heading after ## [Unreleased]');
    } else {
      const match = RELEASE_HEADING_RE.exec(headings[1]);
      if (!match) {
        problems.push(`CHANGELOG.md: first release heading "${headings[1]}" must match "## [X.Y.Z] - YYYY-MM-DD"`);
      } else {
        const [, headingVersion, headingDate] = match;
        if (validVersion && headingVersion !== version) {
          problems.push(`CHANGELOG.md: first release heading version is ${headingVersion}, expected ${version}`);
        }
        if (!isValidDate(headingDate)) {
          problems.push(`CHANGELOG.md: invalid release date "${headingDate}"`);
        }
      }
    }
  }

  return problems;
}

export function unreleasedEntries(changelog) {
  if (typeof changelog !== 'string') return 0;
  const lines = changelog.split(/\r?\n/);
  const start = lines.indexOf('## [Unreleased]');
  if (start === -1) return 0;
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) count++;
  }
  return count;
}

export function pendingWarning(changelog, version) {
  const count = unreleasedEntries(changelog);
  if (!count) return null;
  return `release pending: ${count} CHANGELOG line(s) under [Unreleased] since ${version}; `
    + 'follow docs/releasing.md';
}

function checkTag(version, cwd) {
  const tag = `v${version}`;
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let type;
  try {
    type = git('cat-file', '-t', `refs/tags/${tag}`);
  } catch {
    return [`git tag ${tag} does not exist`];
  }
  const problems = [];
  if (type !== 'tag') {
    problems.push(`git tag ${tag} is not an annotated tag`);
  }
  try {
    const tagCommit = git('rev-parse', `refs/tags/${tag}^{commit}`);
    const headCommit = git('rev-parse', 'HEAD');
    if (tagCommit !== headCommit) {
      problems.push(`git tag ${tag} does not point at HEAD`);
    }
  } catch {
    problems.push(`git tag ${tag} could not be resolved to a commit`);
  }
  return problems;
}

function checkGithubRelease(version, cwd) {
  const tag = `v${version}`;
  try {
    execFileSync('gh', ['release', 'view', tag], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [`GitHub Release ${tag} check failed: gh CLI not found`];
    }
    return [`GitHub Release ${tag} not found`];
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const flags = new Set(argv);
  for (const flag of flags) {
    if (flag !== '--tag' && flag !== '--github' && flag !== '--pending') {
      console.error(`Unknown option: ${flag}`);
      console.error('Usage: release-version.mjs [--tag] [--github] | --pending');
      return 1;
    }
  }

  if (flags.has('--pending')) {
    const warning = pendingWarning(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'),
      readJson(join(cwd, 'package.json')).version);
    if (warning) console.error(warning);
    return 0;
  }

  const pkg = readJson(join(cwd, 'package.json'));
  const lock = readJson(join(cwd, 'package-lock.json'));
  const readme = readFileSync(join(cwd, 'README.md'), 'utf8');
  const readmeTr = readFileSync(join(cwd, 'README.tr.md'), 'utf8');
  const schema = readJson(join(cwd, 'test/fixtures/schema.json'));
  const changelog = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8');

  const problems = checkReleaseVersion({ pkg, lock, readme, readmeTr, schema, changelog });
  if (!problems.length && flags.has('--tag')) {
    problems.push(...checkTag(pkg.version, cwd));
  }
  if (!problems.length && flags.has('--github')) {
    problems.push(...checkGithubRelease(pkg.version, cwd));
  }

  if (problems.length) {
    for (const problem of problems) console.error(problem);
    return 1;
  }
  console.log(pkg.version);
  const warning = pendingWarning(changelog, pkg.version);
  if (warning) console.error(warning);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
