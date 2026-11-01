import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDenylist, matchTerms } from '../security/denylist.mjs';

function denylistFile(t, text) {
  const directory = mkdtempSync(join(tmpdir(), 'denylist-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'terms.txt');
  writeFileSync(path, text);
  return path;
}

test('loadDenylist skips comments and blanks and normalizes terms', (t) => {
  const path = denylistFile(t, '  # comment\r\n\r\n ZÖRBLÂX \r\nAcme_Studio\n');
  assert.deepEqual(loadDenylist(path), { terms: ['zorblax', 'acme studio'] });
});

test('loadDenylist reports the source line of a short normalized term', (t) => {
  const path = denylistFile(t, '# comment\n\nZorblax\nab');
  assert.throws(() => loadDenylist(path), { message: 'term too short: line 4' });
  const normalized = denylistFile(t, '  a-  ');
  assert.throws(() => loadDenylist(normalized), { message: 'term too short: line 1' });
});

test('matchTerms uses normalized space boundaries and returns indices once', () => {
  assert.deepEqual(matchTerms('see zorblax-studio repo', ['zorblax studio']), [0]);
  assert.deepEqual(matchTerms('zorblaxian', ['zorblax']), []);
  assert.deepEqual(matchTerms('ZÖRBLÂX acme zorblax', ['acme', 'zorblax', 'studio']), [0, 1]);
  assert.deepEqual(matchTerms('zorblax!', ['zorblax']), [0]);
  assert.deepEqual(matchTerms('acme', []), []);
});

test('matchTerms treats every non letter or digit as a separator', () => {
  assert.deepEqual(matchTerms('"zorblax",(acme)', ['zorblax', 'acme']), [0, 1]);
  assert.deepEqual(matchTerms('acme.studio', ['acme studio']), [0]);
  assert.deepEqual(matchTerms('acme2', ['acme']), []);
});
