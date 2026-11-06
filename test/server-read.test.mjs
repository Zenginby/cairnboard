import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { homeView } from '../cli/views.mjs';
import { okEnvelope } from '../cli/output.mjs';
import { createRead, DataNotReadyError } from '../server/read.mjs';
import tr from '../src/i18n/tr.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import { language, t as translate } from '../src/i18n/index.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

test('in-process Home returns the CLI envelope and combines context and view warnings', async (t) => {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  mkdirSync(join(data, 'notes'), { recursive: true });
  writeFileSync(join(data, 'notes/pinned.md'), '---\nid: n-000001\ntitle: Pinned title\npinned: true\n---\nA note.');
  const ctx = openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  ctx.warnings.push('pending_recovery', 'pending_recovery');
  const view = homeView(ctx);
  let opens = 0;
  const reader = createRead({ open: () => { opens++; return ctx; } });
  const result = await reader.home();
  assert.deepEqual(result, okEnvelope(view.data, [...ctx.warnings, ...view.warnings]));
  assert.equal(result.data.pinned[0].content.title, 'Pinned title');
  assert.equal(result.warnings.filter((code) => code === 'pending_recovery').length, 1);
  await reader.home();
  assert.equal(opens, 2, 'each request opens a fresh read context');
});

test('only context-open failures become data-not-ready errors', async () => {
  const failure = new Error('open failed');
  for (const open of [() => { throw failure; }, async () => { throw failure; }]) {
    await assert.rejects(createRead({ open }).home(), (error) => {
      assert.ok(error instanceof DataNotReadyError);
      assert.equal(error.code, 'data_not_ready');
      assert.equal(error.cause, failure);
      return true;
    });
  }
  await assert.rejects(createRead({ open: () => null }).home(), (error) => {
    assert.ok(!(error instanceof DataNotReadyError));
    return true;
  });
});

test('Home dictionaries share keys and the language is chosen in one place', () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  assert.equal(language, 'tr');
  assert.equal(translate('shell.home'), tr['shell.home']);
  for (const value of [...Object.values(tr), ...Object.values(en)]) assert.ok(value.trim());
});
