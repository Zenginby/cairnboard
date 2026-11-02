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

test('normalize decodes code-point escapes and HTML references', () => {
  for (const sample of ['\\u0041cme', '\\u{41}cme', '\\u{000041}cme', '\\x41cme', '&#65;cme', '&#65cme', '&#x41;cme', '&#X41;cme', '&#x0041;cme']) {
    assert.equal(normalize(sample), 'acme', sample);
  }
  assert.equal(normalize('acme&amp;zorblax&lt;&gt;&quot;&apos;&nbsp;x'), 'acme zorblax x');
  assert.equal(normalize('\\uD835\\uDC00cme'), 'acme');
});

test('normalize unwraps nested escapes', () => {
  for (const sample of ['&amp;#x41;cme', '%5Cu0041cme', '&#38;#65;cme', '\\u0026#x41;cme', '%26amp;#65;cme']) {
    assert.equal(normalize(sample), 'acme', sample);
  }
});

test('normalize keeps invalid escapes as written without throwing', () => {
  for (const [sample, expected] of [
    ['\\u{110000}acme', 'u 110000 acme'],
    ['\\u{1234567}', 'u 1234567'],
    ['&#1114112;acme', '1114112 acme'],
    ['&#x110000;acme', 'x 110000 acme'],
    [`&#${'9'.repeat(24)};`, '9'.repeat(24)],
    ['\\uD800acme', 'u d 800 acme'],
    ['&#xDFFF;acme', 'x dfff acme'],
    ['\\uZZZZ \\x4 &#; &#x; &bogus; &AMP', 'u zzzz x 4 x bogus amp'],
  ]) {
    assert.equal(normalize(sample), expected, sample);
  }
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

test('normalize strips invisible and format characters before folding', () => {
  assert.equal(normalize('zor\u200Bblax'), 'zorblax');
  assert.equal(normalize('zor\u00ADblax'), 'zorblax');
  assert.equal(normalize('zo\u200Cr\u200Dblax'), 'zorblax');
  assert.equal(normalize('\uFEFFzorblax'), 'zorblax');
  assert.equal(normalize('zor\u200Ebl\u200Fax'), 'zorblax');
  assert.equal(normalize('zor\u202Abla\u202Ex'), 'zorblax');
  assert.equal(normalize('zor\u2066bla\u2069x'), 'zorblax');
  assert.equal(normalize('zor\uFE0Fblax'), 'zorblax');
  assert.equal(normalize('zor\u3164blax'), 'zorblax');
  assert.equal(normalize('zor%E2%80%8Bblax'), 'zorblax');
  assert.equal(normalize('zor%C2%ADblax'), 'zorblax');
});

test('normalize splits camelCase and letter-digit boundaries', () => {
  assert.equal(normalize('ZorblaxClient'), 'zorblax client');
  assert.equal(normalize('zorblaxClient'), 'zorblax client');
  assert.equal(normalize('ACMEClient'), 'acme client');
  assert.equal(normalize('zorblax2'), 'zorblax 2');
  assert.equal(normalize('2zorblax'), '2 zorblax');
  assert.equal(normalize('Zorblax2Client'), 'zorblax 2 client');
});

// The gate keeps its own copy so it never depends on core/; this pins it to core's Turkish folding.
test('normalize folds exactly like core foldTr', async () => {
  const { foldTr } = await import('../core/text.mjs');
  const viaCore = (s) => foldTr(s).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const samples = [
    'İSTANBUL', 'Iğdır', 'ışık', 'ŞEKER', 'İ', 'ﬁ', 'K', 'Çağrı Öz',
    'İ\u200BSTANBUL', 'I\u00ADğdır', '\uFEFFışık', 'Ş\u200CE\u200DKER', 'Çağrı\u200E Öz', 'A\u2066ğ\u2069a',
    '\u00AD', '\u200B', '\u200C', '\u200D', '\uFEFF', '\u200E', '\u200F', '\u202A', '\u202E', '\u2066', '\u2069', '\u3164', '\uFE0F',
  ];
  for (let code = 0; code < 0x3000; code++) samples.push(String.fromCodePoint(code));
  for (const sample of samples) assert.equal(normalize(sample), viaCore(sample), `U+${sample.codePointAt(0).toString(16)}`);
});
