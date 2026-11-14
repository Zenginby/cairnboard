import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, homeSlots, homeSpans, pack, place } from '../src/components/bento-pack.mjs';

const holes = (slots) => {
  const spans = pack(slots);
  const cells = place(slots.map((slot, i) => ({ ...slot, span: spans[i] })));
  const grid = [];
  for (const { row, col, span, rows } of cells) {
    for (let r = row; r < row + rows; r += 1) {
      grid[r] ??= Array(COLUMNS).fill(false);
      for (let c = col; c < col + span; c += 1) grid[r][c] = true;
    }
  }
  return grid.flatMap((row, r) => row.flatMap((filled, c) => (filled ? [] : [`${r}:${c}`])));
};

test('place follows sparse auto-placement and skips cells a two-row box holds', () => {
  const cells = place([{ span: 4, rows: 2 }, { span: 2 }, { span: 3 }]);
  assert.deepEqual(cells.map(({ row, col }) => [row, col]), [[0, 0], [0, 4], [2, 0]]);
});

test('pack widens the box before a hole, never a two-row box', () => {
  assert.deepEqual(pack([{ span: 3 }, { span: 2 }, { span: 2 }]), [3, 3, 6]);
  assert.deepEqual(pack([{ span: 4, rows: 2 }, { span: 2 }]), [4, 2]);
});

test('no Home layout leaves a hole, whichever boxes render', () => {
  const failures = [];
  for (let count = 0; count <= 5; count += 1) {
    for (const featured of count ? [false, true] : [false]) {
      for (let mask = 0; mask < 32; mask += 1) {
        const present = {
          calendar: Boolean(mask & 1), agents: Boolean(mask & 2), research: Boolean(mask & 4),
          pinned: Boolean(mask & 8), recent: Boolean(mask & 16),
          projects: Array.from({ length: count }, (_, i) => ({ featured: featured && i === 0 })),
        };
        const found = holes(homeSlots(present));
        if (found.length) failures.push(`${JSON.stringify(present)}: ${found.join(' ')}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('homeSpans returns classes only for boxes that grow', () => {
  const spans = homeSpans({ calendar: true, projects: [{ featured: true }, { featured: false }], agents: true,
    research: false, pinned: true, recent: false });
  assert.deepEqual(spans, { agents: 'span-3', pinned: 'span-6' });
});
