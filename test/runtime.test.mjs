import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CairnError } from '../core/errors.mjs';
import { checkRuntime } from '../core/runtime.mjs';

function unsupported(version) {
  return (error) => {
    assert.ok(error instanceof CairnError);
    assert.equal(error.code, 'runtime_unsupported');
    assert.equal(error.exit, 5);
    assert.equal(error.message, `Cairnboard needs Node 22.23.4 or newer with SQLite FTS5 (found ${version}). ` +
      'Upgrade at https://nodejs.org.');
    return true;
  };
}

test('old Node versions fail before loading SQLite', async () => {
  for (const nodeVersion of ['20.19.0', '22.15.1', '22.22.9', '22.23.3']) {
    await assert.rejects(checkRuntime({
      nodeVersion,
      sqlite: () => assert.fail('SQLite must not load on an unsupported Node version'),
    }), unsupported(nodeVersion));
  }
});

test('missing FTS5 fails and closes the in-memory database', async () => {
  let closed = false;
  await assert.rejects(checkRuntime({
    nodeVersion: '22.23.4',
    sqlite: async () => ({
      DatabaseSync: class {
        constructor(path) { assert.equal(path, ':memory:'); }
        exec(sql) {
          assert.match(sql, /CREATE VIRTUAL TABLE .* USING fts5\(/);
          throw new Error('no such module: fts5');
        }
        close() { closed = true; }
      },
    }),
  }), unsupported('22.23.4'));
  assert.equal(closed, true);
});

test('SQLite import and database creation failures become runtime errors', async () => {
  for (const sqlite of [
    async () => { throw new Error('module unavailable'); },
    () => ({ DatabaseSync: class { constructor() { throw new Error('cannot open'); } } }),
  ]) {
    await assert.rejects(checkRuntime({ nodeVersion: '22.23.4', sqlite }), unsupported('22.23.4'));
  }
});

test('supported versions create an FTS5 table and close the database', async () => {
  for (const nodeVersion of ['22.23.4', '22.23.10', '22.24.0', '24.0.0']) {
    const calls = [];
    assert.equal(await checkRuntime({
      nodeVersion,
      sqlite: () => ({
        DatabaseSync: class {
          constructor(path) { calls.push(path); }
          exec(sql) { calls.push(sql); }
          close() { calls.push('close'); }
        },
      }),
    }), undefined);
    assert.equal(calls[0], ':memory:');
    assert.match(calls[1], /CREATE VIRTUAL TABLE .* USING fts5\(/);
    assert.equal(calls[2], 'close');
    assert.equal(calls.length, 3);
  }
});

test('minimum version with real SQLite supports FTS5', async () => {
  assert.equal(await checkRuntime({ nodeVersion: '22.23.4' }), undefined);
});

test('current runtime passes with default options', async () => {
  assert.equal(await checkRuntime(), undefined);
});
