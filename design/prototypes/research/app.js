import { startDocument, noteGroups, documentList } from '../_shared/doc-frame.js';

startDocument({
  sidebar: (ctx) => ({ groups: noteGroups(ctx, true) }),
  prepare(ctx) {
    const types = ['İnceleme', 'Deney', 'Kaynak'];
    ctx.data.notes.filter((record) => record.kind === 'research').forEach((record, index) => { record.type = types[index % types.length]; });
  },
  render(ctx) {
    const records = ctx.data.notes.filter((record) => record.kind === 'research');
    ctx.header('Araştırmalar', 'research/', () => records.map((record) => `## ${record.title}\n\n${record.body}`).join('\n\n'));
    ctx.body.replaceChildren(documentList(ctx, records, { research: true }));
  }
});
