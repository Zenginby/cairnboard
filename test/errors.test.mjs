import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CairnError, ERRORS } from '../core/errors.mjs';
import { fixedClock, systemClock } from '../core/clock.mjs';

test('every error code maps to its fixed exit code', () => {
  assert.deepEqual(ERRORS, {
    internal: 1,
    index_unavailable: 1,
    usage: 2,
    actor_required: 2,
    not_found: 3,
    nothing_to_undo: 3,
    conflict: 4,
    claimed: 4,
    validation: 5,
    no_role_column: 5,
    duplicate_id: 5,
    format_too_new: 5,
    unsafe_path: 5,
    unsupported_frontmatter: 5,
    bad_encoding: 5,
    runtime_unsupported: 5,
    locked: 6,
    confirmation_required: 7,
  });
  for (const [code, exit] of Object.entries(ERRORS)) assert.equal(new CairnError(code, 'x').exit, exit);
});

test('error carries code, message and details', () => {
  const error = new CairnError('conflict', 'changed', { current: { revision: 'abc' } });
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'conflict');
  assert.equal(error.message, 'changed');
  assert.deepEqual(error.details, { current: { revision: 'abc' } });
});

test('unknown error code is a programming error', () => {
  assert.throws(() => new CairnError('nope', 'x'), TypeError);
});

test('fixed clock is deterministic and advances', () => {
  const clock = fixedClock('2026-11-01T18:40:00Z');
  assert.equal(clock.now().toISOString(), '2026-11-01T18:40:00.000Z');
  clock.advance(60_000);
  assert.equal(clock.now().toISOString(), '2026-11-01T18:41:00.000Z');
  assert.ok(systemClock.now() instanceof Date);
});
