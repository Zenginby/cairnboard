import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssTimeMs } from '../src/scripts/css-time.js';

// The production build minifies `800ms` to `.8s`; a script that reads a duration token must accept both units.
test('cssTimeMs reads a CSS time in either unit as milliseconds', () => {
  assert.equal(cssTimeMs('800ms'), 800);
  assert.equal(cssTimeMs('.8s'), 800);
  assert.equal(cssTimeMs(' 0.25s '), 250);
  assert.equal(cssTimeMs('150MS'), 150);
  assert.equal(cssTimeMs('0s'), 0);
});

test('cssTimeMs returns 0 for anything that is not a time', () => {
  for (const value of ['', 'fast', '12px', '-1s', undefined, null]) assert.equal(cssTimeMs(value), 0);
});
