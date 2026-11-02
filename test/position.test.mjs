import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBetween } from '../core/position.mjs';

test('keyBetween returns initial key a0 when no bounds are provided', () => {
  assert.equal(keyBetween(null, null), 'a0');
});

test('keyBetween throws RangeError when bounds are identical or inverted', () => {
  assert.throws(() => keyBetween('a0', 'a0'), RangeError);
  assert.throws(() => keyBetween('a1', 'a0'), RangeError);
});

test('keyBetween generates sortable keys across 1000 random insertions', () => {
  const list = [keyBetween(null, null)];
  for (let i = 0; i < 1000; i++) {
    const idx = Math.floor(Math.random() * (list.length + 1));
    const prev = idx === 0 ? null : list[idx - 1];
    const next = idx === list.length ? null : list[idx];
    const key = keyBetween(prev, next);
    list.splice(idx, 0, key);
  }

  for (let i = 0; i < list.length - 1; i++) {
    assert.ok(list[i] < list[i + 1], `list[${i}] (${list[i]}) should be < list[${i + 1}] (${list[i + 1]})`);
  }
});

test('keyBetween handles basic append, prepend and midpoint insertions', () => {
  const first = keyBetween(null, null); // a0
  const second = keyBetween(first, null); // a1
  const third = keyBetween(second, null); // a2
  const mid = keyBetween(first, second); // a0V
  const prepend = keyBetween(null, first); // Zz

  assert.ok(prepend < first);
  assert.ok(first < mid);
  assert.ok(mid < second);
  assert.ok(second < third);
});
