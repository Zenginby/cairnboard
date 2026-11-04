import { startDocument, noteGroups, renderMarkdown, references, section, el, projectChip } from '../_shared/doc-frame.js';

const id = new URLSearchParams(location.search).get('id') || 'research-1';
const bodyFor = (ctx) => `${ctx.record.body}\n\n${ctx.data.findings}`;
startDocument({
  firstStep(ctx) { ctx.setState('full'); },
  emptyLabel: 'Araştırmaya dön',
  emptyMessage: 'Bu araştırma belgesinde henüz içerik yok.',
  record: (ctx) => ctx.data.notes.find((record) => record.id === id && record.kind === 'research') || ctx.data.notes.find((record) => record.kind === 'research'),
  sidebar: (ctx) => ({ groups: noteGroups(ctx, true) }),
  markdown: bodyFor,
  render(ctx) {
    const record = ctx.record;
    ctx.header(record.title, `research/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`);
    const meta = el('div', 'row research-meta type-label muted');
    meta.append(projectChip(ctx.data.projects.find((project) => project.id === record.projectId)), el('span', 'document-badge', 'İnceleme'), el('time', '', record.updated));
    const source = el('aside', 'research-source'); source.setAttribute('aria-label', 'Araştırma kaynağı');
    const list = el('dl'); const label = el('dt', '', 'Kaynak'); const detail = el('dd', '', 'Yerel örnek notlar · Ada ve Deniz’in gözlemleri'); list.append(label, detail, el('dt', '', 'Yöntem'), el('dd', '', 'Üç notla küçük bir kullanım denemesi · 3 Kasım 2026'));
    source.append(list, el('p', '', 'Bu belge kurgusal bir çalışma kaydıdır. Bulgular daha geniş bir örnekle doğrulanacak.'));
    const links = section('Bağlantılar', 'links');
    links.append(references([{ kind: 'Not', title: 'İlk fikirler', detail: 'Kararın bağlamı', href: '../note/?id=note-1' }, { kind: 'Günlük', title: '3 Kasım 2026', detail: 'Deneyin çalışma kaydı', href: '../journal-day/?date=2026-11-03' }, { kind: 'Proje', title: ctx.data.projects.find((project) => project.id === record.projectId).name, detail: 'Projenin genel görünümü', href: `../project/?project=${record.projectId}` }]));
    ctx.body.replaceChildren(meta, source, renderMarkdown(bodyFor(ctx), ctx.data.notes), links);
  }
});
