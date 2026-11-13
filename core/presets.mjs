const entryTypes = {
  decision: ['Karar', 'Decision'], discovery: ['Keşif', 'Discovery'],
  pitfall: ['Tuzak', 'Pitfall'], lesson: ['Ders', 'Lesson'],
};

const ignore = ['.cairn/**', '.git/**', '.obsidian/**', 'node_modules/**'];

export const PRESETS = {
  default: {
    schemaVersion: 1,
    roots: {
      note: { path: ['notes', 'wiki'], flat: false },
      research: { path: 'research', flat: true }, project: { path: 'projects', flat: true },
      journal: { path: 'journal', flat: true }, card: { path: 'cards', flat: true },
    },
    kindFolders: {
      concept: 'wiki/concepts', tool: 'wiki/tools', query: 'wiki/queries', overview: 'wiki/overview.md',
    },
    quickNotes: 'notes',
    fields: {},
    values: {},
    ignore: [...ignore],
    sourceRoots: ['raw'],
    catalog: null,
    entryTypes: structuredClone(entryTypes),
  },
  'tr-wiki': {
    schemaVersion: 1,
    roots: {
      note: { path: 'wiki', flat: false },
      research: { path: 'wiki/kaynaklar', flat: true }, project: { path: 'wiki/projeler', flat: true },
      journal: { path: 'wiki/gunluk-loglar', flat: true }, card: { path: 'cards', flat: true },
    },
    kindFolders: {
      concept: 'wiki/kavramlar', tool: 'wiki/araclar', query: 'wiki/sorgular', overview: 'wiki/genel-bakis.md',
    },
    quickNotes: '',
    fields: {
      kind: 'tur', tags: 'etiketler', updated: 'guncelleme', sources: 'kaynaklar', raw: 'ham', sourceDate: 'kaynak_tarihi', category: 'kategori',
    },
    values: {
      kind: {
        kavram: 'concept', arac: 'tool', sorgu: 'query', kaynak: 'source',
        'genel-bakis': 'overview', proje: 'project', gunluk: 'journal',
      },
    },
    ignore: [...ignore, 'incelemeler/**', 'graf/**', 'raw/fikirler/**', 'CLAUDE.md', 'AGENTS.md', 'index.md', 'log.md'],
    sourceRoots: ['raw', 'incelemeler'],
    catalog: 'index.md',
    entryTypes: structuredClone(entryTypes),
  },
};
