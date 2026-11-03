import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldTr,
  oneLine,
  pathKey,
  slugify,
  stripHidden,
  uniqueName,
} from '../core/text.mjs';

test('slugify handles Turkish folding, accents, separators and bounds', () => {
  assert.equal(slugify('Giriş Sayfası İçin Öneri'), 'giris-sayfasi-icin-oneri');
  assert.equal(slugify('🎉🎉'), 'untitled');
  assert.equal(slugify('../../etc'), 'etc');
  assert.equal(slugify('a/b'), 'a-b');
  assert.equal(slugify('CON'), 'con-x');
  assert.equal(slugify('PRN'), 'prn-x');
  assert.equal(slugify('com1'), 'com1-x');
  assert.equal(slugify('lpt9'), 'lpt9-x');
  assert.equal(slugify('a'.repeat(300)).length, 60);
  assert.equal(slugify('   '), 'untitled');
  assert.equal(slugify(''), 'untitled');
});

test('pathKey normalizes to NFC and lowercase for case and unicode fold checking', () => {
  assert.equal(pathKey('Kart.md'), 'kart.md');
  assert.equal(pathKey('Kart.md'), pathKey('kart.md'));
  const nfd = 'Kart.md'.normalize('NFD');
  const nfc = 'Kart.md'.normalize('NFC');
  assert.equal(pathKey(nfd), pathKey(nfc));
  assert.equal(pathKey('cards\\Kart.md'), 'cards/kart.md');
});

test('uniqueName generates sequential collision-free slug based on pathKey', () => {
  assert.equal(uniqueName(new Set(['a', 'a-2']), 'a'), 'a-3');
  assert.equal(uniqueName(new Set(), 'acme'), 'acme');
  assert.equal(uniqueName(new Set(['acme']), 'acme'), 'acme-2');
  assert.equal(uniqueName(new Set(['Acme']), 'acme'), 'acme-2');
});

test('foldTr folds Turkish characters, lowercases and removes combining marks', () => {
  assert.equal(foldTr('İSTANBUL Işık'), foldTr('istanbul isik'));
  assert.equal(foldTr('ÇĞIİÖŞÜ ÂÎÛ'), 'cgiiosu aiu');
});

test('foldTr removes invisible and format characters', () => {
  assert.equal(foldTr('zor\u200Bblax'), 'zorblax');
  assert.equal(foldTr('zor\u00ADblax'), 'zorblax');
  assert.equal(foldTr('zo\u200Cr\u200Dblax'), 'zorblax');
  assert.equal(foldTr('\uFEFFzorblax'), 'zorblax');
  assert.equal(foldTr('zor\u200Ebl\u200Fax'), 'zorblax');
  assert.equal(foldTr('zor\u202Abla\u202Ex'), 'zorblax');
  assert.equal(foldTr('zor\u2066bla\u2069x'), 'zorblax');
});

test('stripHidden removes invisible formatting and non-tab/newline control characters', () => {
  assert.deepEqual(stripHidden('a\u200Bb\u202Ec'), { text: 'abc', removed: 2 });
  assert.deepEqual(stripHidden('\ta\nb'), { text: '\ta\nb', removed: 0 });
  assert.deepEqual(stripHidden('\uFEFFhello\u00ADworld\r\u200C'), { text: 'helloworld', removed: 4 });
});

test('oneLine collapses whitespace-like control characters to a single space', () => {
  assert.equal(oneLine('a\tb\nc'), 'a b c');
  assert.equal(oneLine('acme\r\nzorblax'), 'acme zorblax');
});

test('stripHidden removes tag characters, variation selectors and line separators', () => {
  const tags = [...'run'].map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
  const input = `a${tags}b️⁠ c\u{E0100}`;
  assert.deepEqual(stripHidden(input), { text: 'abc', removed: 7 });
  assert.equal(oneLine('a b c\u0085d'), 'a b c d');
});
