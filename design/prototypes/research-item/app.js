import { startDocument, noteGroups, renderMarkdown, markdownEditor, references, section, el, button, projectChip } from '../_shared/doc-frame.js';

const id = new URLSearchParams(location.search).get('id') || 'research-1';
let editing = false;
let deleted = false;
// An edit replaces the whole Markdown; until then the fixture's own text (plus the shared findings for research-1) is shown.
const bodyFor = (ctx) => ctx.record.markdown ?? (ctx.record.id === 'research-1' ? `${ctx.record.body}\n\n${ctx.data.findings}` : ctx.record.body);
const startEdit = (ctx) => {
  if (!ctx.canWrite()) return;
  editing = true; ctx.refresh(); ctx.focus('.doc-editor textarea');
};
startDocument({
  copy: {
    empty: ['Araştırmanın içeriği boş', 'Kaydedilmiş bulguları görmek için belgeye dön.', 'Araştırmaya dön'],
    loading: ['Araştırma açılıyor', 'Bulgular, kaynak bilgisi ve ilgili notlar okunuyor.'],
    error: ['Araştırma okunamadı', 'Araştırma dosyasına erişimi kontrol et, sonra belgeyi yeniden yükle.'],
  },
  firstStep(ctx) { ctx.setState('full'); },
  reset(ctx, value) { editing = value === 'conflict'; deleted = false; },
  reload(ctx) { ctx.record.markdown = `${bodyFor(ctx)}\n\nDışarıda eklenen not: Son değişikliğin tarihini de kaydet.`; editing = false; },
  record: (ctx) => ctx.data.notes.find((record) => record.id === id && record.kind === 'research'),
  sidebar: (ctx) => ({ groups: noteGroups(ctx, true) }),
  markdown: bodyFor,
  render(ctx) {
    const record = ctx.record;
    ctx.header(record.title, `research/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`);
    if (deleted) { ctx.body.replaceChildren(el('p', 'muted', 'Araştırma çöp kutusuna taşındı. Geri al ile bu oturumda geri getirebilirsin.')); return; }
    const locked = ctx.state === 'locked';
    const toolbar = el('div', 'row doc-toolbar');
    const edit = button('Araştırmayı düzenle', () => startEdit(ctx)); edit.id = 'research-edit';
    const remove = button('Araştırmayı sil', () => ctx.confirm('Araştırmayı çöp kutusuna taşı', 'Bu araştırma çöp kutusuna taşınacak. İşlemi geri alabilirsin.', () => {
      deleted = true; record.trashed = true; editing = false; ctx.refresh(); ctx.focus();
      ctx.toast('Araştırma çöp kutusuna taşındı.', () => { deleted = false; record.trashed = false; ctx.refresh(); });
    }, 'Çöp kutusuna taşı'), 'button button--danger');
    [edit, remove].forEach((node) => { node.disabled = locked; });
    toolbar.append(edit, remove);
    if (locked) toolbar.append(el('span', 'type-label muted', 'claude üzerinde çalışıyor. Kilit kalkana kadar düzenlenemez.'));
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
    if (editing) {
      const editor = markdownEditor(ctx, bodyFor(ctx), (value) => { record.markdown = value; editing = false; ctx.refresh(); ctx.focus('#research-edit'); ctx.toast('Araştırma kaydedildi.'); }, () => { editing = false; ctx.refresh(); ctx.focus('#research-edit'); }, 'Araştırmayı kaydet');
      ctx.body.replaceChildren(toolbar, meta, editor.node); return;
    }
    ctx.body.replaceChildren(toolbar, meta, source, renderMarkdown(bodyFor(ctx), ctx.data), links);
  }
});
