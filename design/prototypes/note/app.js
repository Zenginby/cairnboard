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
  firstStep(ctx) { ctx.setState('full'); startEdit(ctx); },
  emptyLabel: 'İlk notu yaz',
  render(ctx) {
    const record = ctx.record;
    if (deleted) { ctx.header(record.title, `notes/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`); ctx.body.replaceChildren(el('p', 'muted', 'Not çöp kutusuna taşındı. Geri al ile bu oturumda geri getirebilirsiniz.')); return; }
    const toolbar = el('div', 'row doc-toolbar');
    const edit = button('Düzenle', () => startEdit(ctx));
    // Pin sits with the page actions in the title row: a pushpin that fills in when the note is pinned.
    const pin = button('', () => {
      if (!ctx.canWrite()) return;
      record.pinned = !record.pinned; ctx.refresh(); ctx.focus('#note-pin'); ctx.toast(record.pinned ? 'Not sabitlendi.' : 'Notun sabitlemesi kaldırıldı.');
    }, `button doc-pill doc-pin${record.pinned ? ' is-pinned' : ''}`);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const pinPath = document.createElementNS(icon.namespaceURI, 'path');
    pinPath.setAttribute('d', 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v5');
    icon.append(pinPath);
    pin.append(icon, document.createTextNode('Sabitle'));
    pin.setAttribute('aria-pressed', String(record.pinned));
    pin.title = record.pinned ? 'Sabitlemeyi kaldır' : 'Sabitlenenlere ekle';
    pin.id = 'note-pin'; edit.id = 'note-edit';
    ctx.header(record.title, `notes/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`, false, [pin]);
    const remove = button('Sil', () => ctx.confirm('Notu çöp kutusuna taşı', 'Bu not çöp kutusuna taşınacak. İşlemi geri alabilirsiniz.', () => {
      deleted = true; record.trashed = true; editing = false; ctx.refresh(); ctx.focus();
      ctx.toast('Not çöp kutusuna taşındı.', () => { deleted = false; record.trashed = false; ctx.refresh(); });
    }, 'Çöp kutusuna taşı'), 'button button--danger');
    [edit, pin, remove].forEach((node) => { node.disabled = ctx.state === 'locked'; });
    toolbar.append(edit, remove);
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
