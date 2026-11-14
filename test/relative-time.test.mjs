import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime } from '../src/components/relative-time.mjs';

const now = Date.parse('2026-11-14T12:00:00Z');

test('relativeTime picks the largest whole unit and keeps the full date for the title', () => {
  assert.equal(relativeTime('2026-11-14T11:59:40Z', { now }).text, 'şimdi');
  assert.equal(relativeTime('2026-11-14T11:15:00Z', { now }).text, '45 dk. önce');
  assert.equal(relativeTime('2026-11-14T09:00:00Z', { now }).text, '3 sa. önce');
  assert.equal(relativeTime('2026-11-13T09:00:00Z', { now }).text, 'dün');
  assert.equal(relativeTime('2026-11-10T09:00:00Z', { now }).text, '4 gün önce');
  assert.equal(relativeTime('2026-10-01T09:00:00Z', { now }).text, 'geçen ay');
  assert.equal(relativeTime('2026-11-14T09:00:00Z', { now, locale: 'en' }).text, '3 hr. ago');
  const result = relativeTime('2026-11-14T09:00:00Z', { now });
  assert.equal(result.iso, '2026-11-14T09:00:00Z');
  assert.match(result.full, /14 Kasım 2026/u);
});

test('relativeTime returns null for a missing or broken date', () => {
  assert.equal(relativeTime(undefined, { now }), null);
  assert.equal(relativeTime('yesterday-ish', { now }), null);
});
