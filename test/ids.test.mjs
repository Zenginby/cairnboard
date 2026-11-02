import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, normalizeId } from '../core/ids.mjs';

test('newId generates prefix and 6-char Crockford base32 ID', () => {
  const id = newId('c');
  assert.match(id, /^c-[0-9a-hjkmnp-tv-z]{6}$/);
});

test('newId is deterministic with fixed random source', () => {
  const fixed = () => new Uint8Array([0, 1, 2, 3, 4, 5]);
  const id1 = newId('c', fixed);
  const id2 = newId('c', fixed);
  assert.equal(id1, id2);
  assert.equal(id1, 'c-012345');
});

test('newId supports all standard prefixes: p, c, n, r', () => {
  const fixed = () => new Uint8Array([10, 11, 12, 13, 14, 15]);
  assert.match(newId('p', fixed), /^p-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.match(newId('c', fixed), /^c-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.match(newId('n', fixed), /^n-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.match(newId('r', fixed), /^r-[0-9a-hjkmnp-tv-z]{6}$/);
});

test('newId throws on invalid prefix', () => {
  assert.throws(() => newId('x'), TypeError);
  assert.throws(() => newId(''), TypeError);
  assert.throws(() => newId('card'), TypeError);
});

test('normalizeId lowercases valid ID', () => {
  assert.equal(normalizeId('C-4FQ8ZT'), 'c-4fq8zt');
});

test('normalizeId maps Crockford lookalike characters: o->0, i->1, l->1', () => {
  assert.equal(normalizeId('c-4fq8zO'), 'c-4fq8z0');
  assert.equal(normalizeId('c-4fq8zI'), 'c-4fq8z1');
  assert.equal(normalizeId('c-4fq8zL'), 'c-4fq8z1');
  assert.equal(normalizeId('c-4fq8zl'), 'c-4fq8z1');
  assert.equal(normalizeId('c-4fq8zo'), 'c-4fq8z0');
});

test('normalizeId rejects invalid prefixes', () => {
  assert.equal(normalizeId('x-123456'), null);
  assert.equal(normalizeId('a-123456'), null);
});

test('normalizeId rejects invalid characters and formats', () => {
  assert.equal(normalizeId('c-4fq8zu'), null);
  assert.equal(normalizeId('c-12345'), null);
  assert.equal(normalizeId('c-1234567'), null);
  assert.equal(normalizeId('c123456'), null);
  assert.equal(normalizeId(''), null);
  assert.equal(normalizeId(null), null);
  assert.equal(normalizeId(12345), null);
});
