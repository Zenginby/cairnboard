import { startDocument, noteGroups, renderMarkdown, references, section, el, projectChip } from '../_shared/doc-frame.js';

const id = new URLSearchParams(location.search).get('id') || 'research-1';
const bodyFor = (ctx) => ctx.record.id === 'research-1' ? `${ctx.record.body}\n\n${ctx.data.findings}` : ctx.record.body;
startDocument({
  copy: {
    empty: ['Araştırmanın içeriği boş', 'Kaydedilmiş bulguları görmek için belgeye dön.', 'Araştırmaya dön'],
    loading: ['Araştırma açılıyor', 'Bulgular, kaynak bilgisi ve ilgili notlar okunuyor.'],
    error: ['Araştırma okunamadı', 'Araştırma dosyasına erişimi kontrol et, sonra belgeyi yeniden yükle.'],
  },
  firstStep(ctx) { ctx.setState('full'); },
  record: (ctx) => ctx.data.notes.find((record) => record.id === id && record.kind === 'research') || ctx.data.notes.find((record) => record.kind === 'research'),
  sidebar: (ctx) => ({ groups: noteGroups(ctx, true) }),
  markdown: bodyFor,
  render(ctx) {
    const record = ctx.record;
    ctx.header(record.title, `research/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`);
    const meta = el('div', 'row research-meta type-label muted');
    meta.append(projectChip(ctx.data.projects.find((project) => project.id === record.projectId)), el('span', 'document-badge', 'İnceleme'), el('time', '', record.updated));
    const source = el('aside', 'research-source'); source.setAttribute('aria-label', 'Araştırma kaynağı');
    const list = el('dl');
    // Each fact: the main line at full strength, its detail (who, when) quieter underneath.
    const fact = (term, main, detail) => { const dd = el('dd', '', main); dd.append(el('span', 'research-source-detail', detail)); list.append(el('dt', '', term), dd); };
    const cooking = record.id === 'research-1';
    fact('Kaynak', cooking ? 'Pişirme defteri' : record.title, cooking ? 'Ada’nın iki tencereyle yaptığı karşılaştırma' : 'Çalışma notları');
    fact('Yöntem', cooking ? 'Kavurarak ve kavurmadan pişirme' : 'Notları inceleme', record.updated);
    source.append(list);
    if (cooking) source.append(el('p', 'research-source-note', 'Yağ ve su tartılmadı; sonuçları doğrulamak için ölçülü bir pişirme daha gerekiyor.'));
    const links = section('Bağlantılar', 'links');
    const related = ctx.data.notes.find((note) => note.projectId === record.projectId && note.kind !== 'research');
    links.append(references([{ kind: 'Not', title: related.title, detail: 'İlgili çalışma notu', href: `../note/?id=${related.id}` }, { kind: 'Günlük', title: '3 Kasım 2026', detail: cooking ? 'Pişirme günü tutulan kayıt' : 'Çalışma günlüğü', href: '../journal-day/?date=2026-11-03' }, { kind: 'Proje', title: ctx.data.projects.find((project) => project.id === record.projectId).name, detail: 'Projenin genel görünümü', href: `../project/?project=${record.projectId}` }]));
    ctx.body.replaceChildren(meta, source, renderMarkdown(bodyFor(ctx), ctx.data.notes), links);
  }
});
