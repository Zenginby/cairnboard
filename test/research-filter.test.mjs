import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveResearchTypes,
  filterResearchItems,
  researchTypeLabel,
} from '../src/scripts/research-filter.js';

const KIND_LABELS = { source: 'Kaynak', review: 'İnceleme', analysis: 'Analiz' };

test('researchTypeLabel uses custom category before translated kind', () => {
  assert.equal(researchTypeLabel({ category: 'Saha Notu', kind: 'source' }, { kindLabels: KIND_LABELS }), 'Saha Notu');
  assert.equal(researchTypeLabel({ category: '   ', kind: 'review' }, { kindLabels: KIND_LABELS }), 'İnceleme');
  assert.equal(researchTypeLabel({ meta: { kind: 'analysis' }, content: {} }, { kindLabels: KIND_LABELS }), 'Analiz');
  assert.equal(researchTypeLabel({}, { kindLabels: KIND_LABELS, untypedLabel: 'Kayıt' }), 'Kayıt');
});

test('deriveResearchTypes derives sorted groups from mixed category and kind records', () => {
  const records = [
    { content: { category: 'Karşılaştırma' }, meta: { kind: 'analysis' } },
    { content: { category: '' }, meta: { kind: 'source' } },
    { content: {}, meta: { kind: 'source' } },
    { content: { category: 'Arşiv' }, meta: { kind: 'review' } },
    { content: { category: 'Karşılaştırma' }, meta: { kind: 'analysis' } },
  ];
  const groups = deriveResearchTypes(records, { kindLabels: KIND_LABELS, untypedLabel: 'Kayıt', locale: 'tr' });
  assert.deepEqual(groups, [
    { value: 'Arşiv', label: 'Arşiv', count: 1 },
    { value: 'Karşılaştırma', label: 'Karşılaştırma', count: 2 },
    { value: 'Kaynak', label: 'Kaynak', count: 2 },
  ]);
});

test('filterResearchItems filters by text, project and type and computes facet counts', () => {
  const items = [
    { id: 'r-1', title: 'Toprak Nem Ölçümü', project: 'p-alpha1', type: 'Kaynak' },
    { id: 'r-2', title: 'İklim Raporu Özeti', project: 'p-alpha1', type: 'Saha Notu' },
    { id: 'r-3', title: 'Rüzgar Nem Analizi', project: 'p-beta02', type: 'Saha Notu' },
    { id: 'r-4', title: 'Su Kalitesi İncelemesi', project: '', type: 'İnceleme' },
  ];
  const keys = ['Kaynak', 'Saha Notu', 'İnceleme'];

  const all = filterResearchItems(items, { locale: 'tr' }, keys);
  assert.equal(all.total, 4);
  assert.equal(all.allCount, 4);
  assert.deepEqual(all.typeCounts, { Kaynak: 1, 'Saha Notu': 2, İnceleme: 1 });

  const byText = filterResearchItems(items, { query: 'nem', locale: 'tr' }, keys);
  assert.deepEqual(byText.visible.map((item) => item.id), ['r-1', 'r-3']);
  assert.equal(byText.allCount, 2);
  assert.deepEqual(byText.typeCounts, { Kaynak: 1, 'Saha Notu': 1, İnceleme: 0 });

  const byProjectAndText = filterResearchItems(items, { query: 'nem', project: 'p-alpha1', locale: 'tr' }, keys);
  assert.deepEqual(byProjectAndText.visible.map((item) => item.id), ['r-1']);
  assert.equal(byProjectAndText.allCount, 1);
  assert.deepEqual(byProjectAndText.typeCounts, { Kaynak: 1, 'Saha Notu': 0, İnceleme: 0 });

  const combined = filterResearchItems(
    items,
    { query: 'i̇klim'.normalize('NFC'), project: 'p-alpha1', type: 'Saha Notu', locale: 'tr' },
    keys,
  );
  assert.deepEqual(combined.visible.map((item) => item.id), ['r-2']);
  assert.equal(combined.total, 1);
  assert.equal(combined.allCount, 1);
  assert.deepEqual(combined.typeCounts, { Kaynak: 0, 'Saha Notu': 1, İnceleme: 0 });
});
