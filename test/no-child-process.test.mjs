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
  /\bfetch\s*\(/u,
];

function sources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => join(entry.parentPath, entry.name));
}

test('core and cli never spawn processes, open sockets or fetch', () => {
  const violations = [];
  for (const file of ['core', 'cli'].flatMap((dir) => sources(join(repo, dir)))) {
    readFileSync(file, 'utf8').split(/\r?\n/u).forEach((line, i) => {
      if (FORBIDDEN.some((pattern) => pattern.test(line))) {
        violations.push(`${relative(repo, file).replaceAll('\\', '/')}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], `forbidden process or network use:\n${violations.join('\n')}`);
});
