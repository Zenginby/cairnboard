import { startDocument, noteGroups, renderMarkdown, markdownEditor, references, section, el, button, projectChip } from '../_shared/doc-frame.js';

let editing = false;
let deleted = false;
const id = new URLSearchParams(location.search).get('id') || 'note-1';
const bodyFor = (ctx) => ctx.record.markdown || `${ctx.record.body}\n\n${ctx.data.markdown}`;
const startEdit = (ctx) => {
  if (!ctx.canWrite()) return;
  editing = true; ctx.refresh(); ctx.focus('.doc-editor textarea');
};
startDocument({
  record: (ctx) => ctx.data.notes.find((record) => record.id === id && record.kind !== 'research') || ctx.data.notes.find((record) => record.kind !== 'research'),
  sidebar: (ctx) => ({ groups: noteGroups(ctx) }),
  markdown: bodyFor,
  reset(ctx, value) { editing = value === 'conflict'; deleted = false; },
  reload(ctx) { ctx.record.markdown = `${bodyFor(ctx)}\n\nDışarıda eklenen not: Birlikte yeniden gözden geçir.`; editing = false; },
  firstStep: startEdit,
  emptyLabel: 'İlk notu yaz',
  render(ctx) {
    const record = ctx.record;
    ctx.header(record.title, `notes/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`);
    if (deleted) { ctx.body.replaceChildren(el('p', 'muted', 'Not çöp kutusuna taşındı. Geri al ile bu oturumda geri getirebilirsiniz.')); return; }
    const toolbar = el('div', 'row doc-toolbar');
    const edit = button('Düzenle', () => startEdit(ctx));
    const pin = button(record.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle', () => {
      if (!ctx.canWrite()) return;
      record.pinned = !record.pinned; ctx.refresh(); ctx.focus('#note-pin'); ctx.toast(record.pinned ? 'Not sabitlendi.' : 'Notun sabitlemesi kaldırıldı.');
    });
    pin.id = 'note-pin'; edit.id = 'note-edit';
    const remove = button('Sil', () => ctx.confirm('Notu çöp kutusuna taşı', 'Bu not çöp kutusuna taşınacak. İşlemi geri alabilirsiniz.', () => {
      deleted = true; editing = false; ctx.refresh(); ctx.focus();
      ctx.toast('Not çöp kutusuna taşındı.', () => { deleted = false; ctx.refresh(); });
    }, 'Çöp kutusuna taşı'), 'button button--danger');
    [edit, pin, remove].forEach((node) => { node.disabled = ctx.state === 'locked'; });
    toolbar.append(edit, pin, remove);
    if (ctx.state === 'locked') toolbar.append(el('span', 'type-label muted', 'claude üzerinde çalışıyor. Kilit kalkana kadar düzenlenemez.'));
    const meta = el('div', 'row note-meta type-label muted');
    meta.append(projectChip(ctx.data.projects.find((project) => project.id === record.projectId)), el('span', '', `Ada · ${record.updated} · ${record.kind === 'wiki' ? 'Wiki' : 'Not'}`));
    if (editing) {
      const editor = markdownEditor(ctx, bodyFor(ctx), (value) => { record.markdown = value; editing = false; ctx.refresh(); ctx.focus('#note-edit'); ctx.toast('Not kaydedildi.'); }, () => { editing = false; ctx.refresh(); ctx.focus('#note-edit'); });
      ctx.body.replaceChildren(toolbar, meta, editor.node); return;
    }
    const backlinks = section('Bağlantılar', 'backlinks');
    backlinks.append(references([
      { kind: 'Günlük', title: '3 Kasım 2026', detail: 'Bu nota bağlantı veren günlük', href: '../journal-day/?date=2026-11-03' },
      { kind: 'Wiki', title: 'Ajanlarla çalışma anlaşması', detail: 'Çalışma düzeni ve kabul ölçütleri', href: '../note/?id=note-3' }
    ]));
    ctx.body.replaceChildren(toolbar, meta, renderMarkdown(bodyFor(ctx), ctx.data.notes), backlinks);
  }
});
