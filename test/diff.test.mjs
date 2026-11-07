import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from '../core/diff.mjs';

test('single line change', () => {
  const result = lineDiff('one\nold\nthree\n', 'one\nnew\nthree\n');
  assert.match(result.hunks, /@@ -1,3 \+1,3 @@\n one\n-old\n\+new\n three\n/u);
  assert.equal(result.truncated, false);
});

test('addition and deletion', () => {
  assert.match(lineDiff('a\n', 'a\nb\n').hunks, /\+b\n/u);
  assert.match(lineDiff('a\nb\n', 'a\n').hunks, /-b\n/u);
  assert.deepEqual(lineDiff('same\n', 'same\n'), { hunks: '', truncated: false });
});

test('empty to nonempty and back', () => {
  assert.match(lineDiff('', 'a\n').hunks, /@@ -0,0 \+1,1 @@\n\+a\n/u);
  assert.match(lineDiff('a\n', '').hunks, /@@ -1,1 \+0,0 @@\n-a\n/u);
});

test('CRLF is preserved', () => {
  assert.match(lineDiff('a\r\nb\r\n', 'a\r\nc\r\n').hunks, / a\r\n-b\r\n\+c\r\n/u);
});

test('diff is capped at 200 lines and 16 KiB', () => {
  const before = Array.from({ length: 300 }, (_, i) => `old ${i}\n`).join('');
  const after = before.replaceAll('old', 'new');
  const result = lineDiff(before, after);
  assert.equal(result.truncated, true);
  assert.ok(result.hunks.trimEnd().split('\n').length <= 200);
  assert.ok(Buffer.byteLength(result.hunks) <= 16384);
  assert.equal(lineDiff('x'.repeat(20000), 'y'.repeat(20000)).truncated, true);
});

test('surrogate pairs are not split', () => {
  const result = lineDiff('', '🙂'.repeat(100), { maxBytes: 42 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.hunks) <= 42);
  assert.equal(result.hunks.isWellFormed(), true);
});

test('separate hunks use three context lines and large inputs use a summary', () => {
  const before = Array.from({ length: 30 }, (_, i) => `${i}\n`).join('');
  const after = before.replace('3\n', 'changed\n').replace('25\n', 'other\n');
  assert.equal(lineDiff(before, after).hunks.match(/^@@ /gmu).length, 2);
  const large = lineDiff('old\n'.repeat(2001), 'new\n'.repeat(2001));
  assert.equal(large.truncated, true);
  assert.match(large.hunks, /2001/u);
});
