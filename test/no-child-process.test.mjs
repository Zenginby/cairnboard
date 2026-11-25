import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

// Comments count too: a line-based check stays simple, and a commented-out import is one edit away from running.
const FORBIDDEN = [
  /['"`](?:node:)?child_process['"`]/u,
  /['"`]node:(?:http|https|net|dgram|tls)['"`]/u,
  /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"`](?:http|https|net|dgram|tls)['"`]/u,
  /\bfetch\s*\(/u,
];

function sources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => join(entry.parentPath, entry.name));
}

test('core and cli keep process launch in start and leave networking to the server', () => {
  const violations = [];
  for (const file of ['core', 'cli'].flatMap((dir) => sources(join(repo, dir)))) {
    const name = relative(repo, file).replaceAll('\\', '/');
    readFileSync(file, 'utf8').split(/\r?\n/u).forEach((line, i) => {
      if (name === 'cli/commands/start.mjs' && line === "import { spawn } from 'node:child_process';") return;
      if (FORBIDDEN.some((pattern) => pattern.test(line))) {
        violations.push(`${name}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], `forbidden process or network use:\n${violations.join('\n')}`);
});

test('server keeps process and socket use in its entry points', () => {
  const violations = [];
  for (const file of sources(join(repo, 'server'))) {
    const name = relative(repo, file).replaceAll('\\', '/');
    // start.mjs is the entry point: it runs the app build (`npm start` passes --build) before serving.
    const processAllowed = ['server/open-browser.mjs', 'server/start.mjs'].includes(name);
    const socketsAllowed = ['server/listen.mjs', 'server/port.mjs'].includes(name);
    readFileSync(file, 'utf8').split(/\r?\n/u).forEach((line, i) => {
      const checked = socketsAllowed ? line.replace(/(['"`])(?:node:)?(?:http|net)\1/gu, "''") : line;
      if ((!processAllowed && FORBIDDEN[0].test(line))
        || FORBIDDEN[1].test(checked) || FORBIDDEN[2].test(checked)
        || FORBIDDEN[3].test(line)) violations.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(violations, [], `forbidden process or network use:\n${violations.join('\n')}`);
});
