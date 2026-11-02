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

test('normalize keeps valid UTF-8 beside malformed percent bytes', () => {
  assert.equal(normalize('%FF%7A%6F%72%62%6C%61%78'), 'zorblax');
  assert.equal(normalize('%FF%C5%9F%C3%BC%FEkr%C3%BC'), 'su kru');
});

// The gate keeps its own copy so it never depends on core/; this pins it to core's Turkish folding.
test('normalize folds exactly like core foldTr', async () => {
  const { foldTr } = await import('../core/text.mjs');
  const viaCore = (s) => foldTr(s).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const samples = ['İSTANBUL', 'Iğdır', 'ışık', 'ŞEKER', 'İ', 'ﬁ', 'K', 'Çağrı Öz'];
  for (let code = 0; code < 0x3000; code++) samples.push(String.fromCodePoint(code));
  for (const sample of samples) assert.equal(normalize(sample), viaCore(sample), `U+${sample.codePointAt(0).toString(16)}`);
});
