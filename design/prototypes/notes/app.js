import { startDocument, noteGroups, documentList, el, button } from '../_shared/doc-frame.js';

const add = (ctx) => { if (ctx.canWrite()) ctx.ui.create('note'); };
startDocument({
  sidebar: (ctx) => ({ groups: noteGroups(ctx) }),
  firstStep: add,
  created: (ctx, kind) => { if (kind === 'note') ctx.toast('Not eklendi. Bu oturumdaki listede görünüyor.'); },
  render(ctx) {
    ctx.header('Notlar', 'notes/', () => ctx.data.notes.filter((record) => record.kind !== 'research').map((record) => `## ${record.title}\n\n${record.body}`).join('\n\n'));
    const toolbar = el('div', 'row doc-toolbar');
    const create = button('Not ekle', () => add(ctx), 'button button--primary');
    create.disabled = ctx.state === 'locked';
    toolbar.append(create);
    if (ctx.state === 'locked') toolbar.append(el('span', 'type-label muted', 'claude üzerinde çalışıyor.'));
    ctx.body.replaceChildren(toolbar, documentList(ctx, ctx.data.notes.filter((record) => record.kind !== 'research')));
  }
});
