import { startDocument, noteGroups, documentList, el, button } from '../_shared/doc-frame.js';

const add = (ctx) => { if (ctx.canWrite()) ctx.ui.create('note'); };
startDocument({
  copy: {
    empty: ['Not listen boş', 'Başlığını ve içeriğini yazacağın bir not aç.', 'Notu ekle'],
    loading: ['Not listesi okunuyor', 'Not başlıkları ve son değişiklikler alınıyor.'],
    error: ['Not listesi açılamadı', 'notes/ klasörüne erişimi kontrol et, sonra listeyi yeniden yükle.'],
  },
  sidebar: (ctx) => ({ groups: noteGroups(ctx) }),
  firstStep: add,
  created: (ctx, kind) => { if (kind === 'note') ctx.toast('Not eklendi. Bu oturumdaki listede görünüyor.'); },
  render(ctx) {
    ctx.header('Notlar', 'notes/', () => ctx.data.notes.filter((record) => record.kind !== 'research').map((record) => `## ${record.title}\n\n${record.body}`).join('\n\n'));
    const toolbar = el('div', 'row doc-toolbar');
    const create = button('Notu ekle', () => add(ctx), 'button button--primary');
    create.disabled = ctx.state === 'locked';
    toolbar.append(create);
    if (ctx.state === 'locked') toolbar.append(el('span', 'type-label muted', 'claude üzerinde çalışıyor.'));
    ctx.body.replaceChildren(toolbar, documentList(ctx, ctx.data.notes.filter((record) => record.kind !== 'research')));
  }
});
