import assert from 'node:assert/strict';
import { before } from 'node:test';

// Import first only in suites that are entirely about recovery or completed disk flushes.
// Single tests elsewhere call `__setTestFsync(false)` and restore it with `t.after`.
process.env.CAIRN_TEST_NO_FSYNC = '0';
before(async () => assert.equal((await import('../../core/fsx.mjs')).testFsyncSkipped(), false));
