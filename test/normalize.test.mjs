import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../security/normalize.mjs';

test('normalize folds Turkish letters, accents and compatibility characters', () => {
  assert.equal(normalize('ÇĞIİÖŞÜ ÂÎÛ'), 'cgiiosu aiu');
  assert.equal(normalize('ZÖRBLÂX Ağa'), 'zorblax aga');
  assert.equal(normalize('I\u0307 ZO\u0308RBLAX'), 'i zorblax');
  assert.equal(normalize('ａｃｍｅ'), 'acme');
});

test('normalize decodes URLs before folding letters', () => {
  assert.equal(normalize('%C5%9F%C3%BCkr%C3%BC'), 'sukru');
  assert.equal(normalize('%C4%B0'), 'i');
  assert.equal(normalize('acme%2Fzorblax'), 'acme zorblax');
});

test('normalize replaces separators and collapses whitespace', () => {
  assert.equal(normalize('Zorblax_Studio'), 'zorblax studio');
  assert.equal(normalize('  acme-zorblax./studio\t\n '), 'acme zorblax studio');
  assert.equal(normalize(''), '');
});

test('normalize preserves malformed URL encoding without throwing', () => {
  assert.equal(normalize('ACME%ZZ'), 'acme zz');
});
