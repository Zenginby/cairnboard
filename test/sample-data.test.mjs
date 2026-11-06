import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { homeView, boardView, showView } from '../cli/views.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function open(t) {
  const dataDir = join(tempDir(t), 'sample');
  cpSync('sample-data', dataDir, { recursive: true });
  const home = tempDir(t);
  return openContext({ mode: 'read', dataDir, home, env: {}, platform: process.platform, clock: fixedClock('2026-11-06T12:00:00Z') });
}

test('sample data opens read-only and fills the home view', (t) => {
  const ctx = open(t);
  assert.deepEqual(ctx.warnings, []);
  const { data, warnings } = homeView(ctx);
  assert.deepEqual(warnings, []);
  assert.ok(data.pinned.length > 0);
  assert.ok(data.recentNotes.length > 0);
  assert.ok(data.openCards.length > 0);
  assert.ok(data.projects.length >= 3);
  assert.ok(data.projects.some((project) => project.id === data.featuredProject));
  assert.equal(data.projects.find((project) => project.id === data.featuredProject).content.title, 'Mutfak defteri');
});

test('sample data board has cards in every column', (t) => {
  const { data, warnings } = boardView(open(t));
  assert.deepEqual(warnings, []);
  assert.equal(data.columns.length, 4);
  for (const column of data.columns) assert.ok(column.cards.length > 0, column.key);
});

test('sample data shows one card and one note', (t) => {
  const ctx = open(t);
  const card = showView(ctx, 'card', 'c-mrc001');
  assert.equal(card.data.content.title, 'Mercimek çorbasının ölçülerini netleştir');
  const note = showView(ctx, 'note', 'n-cvr001');
  assert.equal(note.data.content.title, 'Çorbanın kıvamı');
  assert.deepEqual([...card.warnings, ...note.warnings], []);
});
