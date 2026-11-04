import { startDocument, section, el, link, projectChip, journalGroups, inline } from '../_shared/doc-frame.js';
import { journalTypes, sectionHeading, sectionMarkdown, sectionProjectId } from '../_shared/journal.js';
import { journalFields } from '../_shared/journal-form.js';

const requested = new URLSearchParams(location.search).get('date');
const validDate = /^\d{4}-\d{2}-\d{2}$/.test(requested || '') && Number.isFinite(new Date(`${requested}T12:00:00`).getTime()) && new Date(`${requested}T12:00:00`).getDate() === Number(requested.slice(8));
const date = validDate ? requested : '2026-11-03';
const dateValue = new Date(`${date}T12:00:00`);
const title = (value) => {
  const day = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(value);
  const weekday = new Intl.DateTimeFormat('tr-TR', { weekday: 'long' }).format(value);
  return `${day}, ${weekday[0].toLocaleUpperCase('tr') + weekday.slice(1)}`;
};
const records = (ctx) => ctx.data.journal.filter((entry) => entry.date === date);
const bodyFor = (ctx) => records(ctx).map(sectionMarkdown).join('\n\n');
startDocument({
  copy: {
    empty: ['Bu günün günlüğü boş', 'Bugüne bir kayıt yazmak için günlük formunu aç.', 'Günlük formunu aç'],
    loading: ['Günün kayıtları açılıyor', 'Seçilen tarihin günlük dosyasındaki bölümler okunuyor.'],
    error: ['Günün kayıtları okunamadı', 'Seçilen tarihin günlük dosyasına erişimi kontrol et, sonra günü yeniden yükle.'],
  },
  markdown: bodyFor,
  firstStep(ctx) { ctx.setState('full'); ctx.focus('#journal-input'); },
  reload(ctx) { records(ctx)[0]?.items.push({ text: 'Tarihi takvimden doğruladım.' }); },
  sidebar(ctx) {
    return { groups: journalGroups(ctx, { day: date }) };
  },
  render(ctx) {
    ctx.header(title(dateValue), `journal/${date}.md`, () => `# ${title(dateValue)}\n\n${bodyFor(ctx)}`);
    ctx.body.replaceChildren();
    if (!records(ctx).length) ctx.body.append(el('p', 'muted', 'Bu gün için henüz kayıt yok. Ay görünümünden kayıtlı bir gün seçebilirsin.'));
    records(ctx).forEach((entry) => {
      const block = section(ctx.text(sectionHeading(entry)), entry.id); block.classList.add('journal-entry');
      const meta = el('div', 'journal-entry-meta');
      const project = ctx.data.projects.find((item) => item.id === sectionProjectId(entry, ctx.data.projects));
      if (project) meta.append(projectChip(project));
      meta.append(el('span', '', `${entry.items.length} madde`));
      block.append(meta);
      if (!entry.items.length) block.append(el('p', 'muted', 'Bu işe henüz madde eklenmedi.'));
      else {
        const list = el('ul');
        entry.items.forEach((item) => {
          const row = el('li');
          if (item.type) row.append(el('strong', '', `${journalTypes[item.type]}: `));
          inline(row, ctx.text(item.text), ctx.data);
          list.append(row);
        });
        block.append(list);
      }
      ctx.body.append(block);
    });
    const navigation = el('nav', 'journal-pagination'); navigation.setAttribute('aria-label', 'Günler arasında gezinme');
    [-1, 1].forEach((offset) => {
      const next = new Date(dateValue); next.setDate(next.getDate() + offset);
      const key = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
      const anchor = link('', `../journal-day/?date=${key}`); anchor.append(el('span', '', offset < 0 ? '← Önceki gün' : 'Sonraki gün →'), el('strong', '', title(next))); navigation.append(anchor);
    });
    const form = el('form', 'stack journal-add');
    const fields = journalFields(ctx.data);
    fields.controls.title.id = 'journal-input';
    const save = el('button', 'button button--primary', 'Bugüne iş ekle'); save.type = 'submit';
    const today = title(new Date(`${ctx.data.dashboard.date}T12:00:00`));
    form.append(el('p', 'type-label muted', `Yeni iş ${today} gününe eklenecek.`), ...fields.nodes, save);
    form.querySelectorAll('input, select, textarea, button').forEach((node) => { node.disabled = ctx.state === 'locked'; });
    if (ctx.state === 'locked') form.append(el('p', 'type-label muted', 'claude üzerinde çalışıyor. Kilit kalkana kadar kayıt eklenemez.'));
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (!ctx.canWrite()) return;
      const value = fields.read();
      if (!value) return;
      ctx.data.journal.push({ id: crypto.randomUUID(), date: ctx.data.dashboard.date, ...value });
      ctx.refresh(); ctx.focus('#journal-input'); ctx.toast('Bugünün günlüğüne eklendi.');
    });
    ctx.body.append(navigation, form);
  }
});
