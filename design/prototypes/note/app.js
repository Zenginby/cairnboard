import { isPinned, pinNote, unpinNote } from '../_shared/pins.js';
import { startDocument, noteGroups, renderMarkdown, markdownEditor, references, section, el, button, projectChip } from '../_shared/doc-frame.js';

let editing = false;
let pageCtx = null;
// Removing this note from the pinned rail updates the Sabitle button here.
document.addEventListener('pinchange', (event) => { if (event.detail?.source === 'rail' && pageCtx && !editing) pageCtx.refresh(); });
let deleted = false;
const id = new URLSearchParams(location.search).get('id') || 'note-1';
const bodyFor = (ctx) => ctx.record.markdown || (ctx.record.id === 'note-1' ? `${ctx.record.body}\n\n${ctx.data.markdown}` : ctx.record.body);
const startEdit = (ctx) => {
  if (!ctx.canWrite()) return;
  editing = true; ctx.refresh(); ctx.focus('.doc-editor textarea');
};
startDocument({
  copy: {
    empty: ['Bu notun içeriği boş', 'Notu düzenleyerek içeriğini yaz.', 'Notu düzenle'],
    loading: ['Not açılıyor', 'Notun Markdown içeriği ve bağlantıları okunuyor.'],
    error: ['Not okunamadı', 'Not dosyasına erişimi kontrol et, sonra notu yeniden yükle.'],
  },
  record: (ctx) => ctx.data.notes.find((record) => record.id === id && record.kind !== 'research') || ctx.data.notes.find((record) => record.kind !== 'research'),
  sidebar: (ctx) => ({ groups: noteGroups(ctx) }),
  created: (ctx, kind) => { if (kind === 'note') ctx.toast('Not eklendi; sol panelde ve Notlar listesinde.'); },
  markdown: bodyFor,
  reset(ctx, value) { editing = value === 'conflict'; deleted = false; },
  reload(ctx) { ctx.record.markdown = `${bodyFor(ctx)}\n\nDışarıda eklenen not: Son değişikliğin tarihini de kaydet.`; editing = false; },
  firstStep(ctx) { ctx.setState('full'); startEdit(ctx); },
  render(ctx) {
    const record = ctx.record;
    pageCtx = ctx;
    record.pinned = isPinned(record.id, Boolean(record.pinned));
    if (deleted) { ctx.header(record.title, `notes/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`); ctx.body.replaceChildren(el('p', 'muted', 'Not çöp kutusuna taşındı. Geri al ile bu oturumda geri getirebilirsin.')); return; }
    const toolbar = el('div', 'row doc-toolbar doc-toolbar--sticky');
    const addNote = button('Not ekle', () => { if (ctx.canWrite()) ctx.ui.create('note'); }, 'button button--primary');
    const edit = button('Notu düzenle', () => startEdit(ctx));
    // Pin sits with the page actions in the title row: a pushpin that fills in when the note is pinned.
    const pin = button('', () => {
      if (!ctx.canWrite()) return;
      record.pinned = !record.pinned;
      if (record.pinned) {
        const project = ctx.data.projects.find((item) => item.id === record.projectId);
        const body = bodyFor(ctx).replace(/[#*_`>[\]-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
        pinNote({ id: record.id, kind: record.kind || 'note', title: record.title, projectId: record.projectId, updated: record.updated || 'Şimdi', body, project: project && { name: project.name, tone: project.tone } });
      } else unpinNote(record.id);
      ctx.refresh(); ctx.focus('#note-pin'); ctx.toast(record.pinned ? 'Not sabitlendi.' : 'Notun sabitlemesi kaldırıldı.');
    }, `button doc-pill doc-pin${record.pinned ? ' is-pinned' : ''}`);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const pinPath = document.createElementNS(icon.namespaceURI, 'path');
    pinPath.setAttribute('d', 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v5');
    icon.append(pinPath);
    pin.append(icon, document.createTextNode('Notu sabitle'));
    pin.setAttribute('aria-pressed', String(record.pinned));
    pin.title = record.pinned ? 'Sabitlemeyi kaldır' : 'Sabitlenenlere ekle';
    pin.id = 'note-pin'; edit.id = 'note-edit';
    ctx.header(record.title, `notes/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`, false, [pin]);
    const remove = button('Notu sil', () => ctx.confirm('Notu çöp kutusuna taşı', 'Bu not çöp kutusuna taşınacak. İşlemi geri alabilirsin.', () => {
      deleted = true; record.trashed = true; editing = false; ctx.refresh(); ctx.focus();
      ctx.toast('Not çöp kutusuna taşındı.', () => { deleted = false; record.trashed = false; ctx.refresh(); });
    }, 'Çöp kutusuna taşı'), 'button button--danger');
    [edit, pin, remove].forEach((node) => { node.disabled = ctx.state === 'locked'; });
    addNote.disabled = ctx.state === 'locked';
    toolbar.append(addNote, edit, remove);
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
      { kind: 'Wiki', title: 'Tarif kayıt düzeni', detail: 'Ölçüler ve fırın ayarları', href: '../note/?id=note-3' }
    ]));
    ctx.body.replaceChildren(toolbar, meta, renderMarkdown(bodyFor(ctx), ctx.data.notes), backlinks);
  }
});
