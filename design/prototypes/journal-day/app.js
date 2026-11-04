import { startDocument, section, el, field, link, projectChip, journalGroups } from '../_shared/doc-frame.js';

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
const bodyFor = (ctx) => records(ctx).map((entry) => `## ${entry.time} · ${ctx.data.people.find((person) => person.id === entry.authorId)?.name || entry.authorId}\n\n- ${entry.body}`).join('\n\n');
startDocument({
  copy: {
    empty: ['Bu günün günlüğü boş', 'Bugüne bir kayıt yazmak için günlük formunu aç.', 'Günlük formunu aç'],
    loading: ['Günün kayıtları açılıyor', 'Seçilen tarihte yazılan kayıtlar saat sırasına alınıyor.'],
    error: ['Günün kayıtları okunamadı', 'Seçilen tarihin günlük dosyasına erişimi kontrol et, sonra günü yeniden yükle.'],
  },
  markdown: bodyFor,
  firstStep(ctx) { ctx.setState('full'); ctx.focus('#journal-input'); },
  reload(ctx) { if (records(ctx)[0]) records(ctx)[0].body += ' Tarihi takvimden doğruladım.'; },
  sidebar(ctx) {
    return { groups: journalGroups(ctx, { day: date }) };
  },
  render(ctx) {
    ctx.header(title(dateValue), `journal/${date}.md`, () => `# ${title(dateValue)}\n\n${bodyFor(ctx)}`);
    ctx.body.replaceChildren();
    if (!records(ctx).length) ctx.body.append(el('p', 'muted', 'Bu gün için henüz kayıt yok. Ay görünümünden kayıtlı bir gün seçebilirsin.'));
    records(ctx).forEach((entry) => {
      const person = ctx.data.people.find((person) => person.id === entry.authorId);
      const block = section(ctx.text(`${entry.time} · ${person?.name || entry.authorId}`), entry.id); block.classList.add('journal-entry');
      const meta = el('div', 'journal-entry-meta');
      const project = ctx.data.projects.find((project) => project.id === entry.projectId) || ctx.data.projects[ctx.data.journal.indexOf(entry) % 3];
      meta.append(projectChip(project), el('span', '', 'Günlük kaydı'));
      const list = el('ul'); list.append(el('li', '', ctx.text(entry.body)));
      block.append(meta, list); ctx.body.append(block);
    });
    const navigation = el('nav', 'journal-pagination'); navigation.setAttribute('aria-label', 'Günler arasında gezinme');
    [-1, 1].forEach((offset) => {
      const next = new Date(dateValue); next.setDate(next.getDate() + offset);
      const key = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
      const anchor = link('', `../journal-day/?date=${key}`); anchor.append(el('span', '', offset < 0 ? '← Önceki gün' : 'Sonraki gün →'), el('strong', '', title(next))); navigation.append(anchor);
    });
    const form = el('form', 'stack journal-add');
    const input = field('Bugüne ekle', 'textarea'); input.control.id = 'journal-input'; input.control.required = true; input.control.disabled = ctx.state === 'locked';
    const save = el('button', 'button button--primary', 'Bugüne kayıt ekle'); save.type = 'submit'; save.disabled = ctx.state === 'locked';
    const today = title(new Date(`${ctx.data.dashboard.date}T12:00:00`));
    form.append(el('p', 'type-label muted', `Yeni kayıt ${today} gününe eklenecek.`), input.wrapper, save);
    if (ctx.state === 'locked') form.append(el('p', 'type-label muted', 'claude üzerinde çalışıyor. Kilit kalkana kadar kayıt eklenemez.'));
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (!ctx.canWrite()) return;
      const value = input.control.value.trim();
      if (!value) { input.control.setCustomValidity('Kısa bir not yaz.'); input.control.reportValidity(); return; }
      ctx.data.journal.push({ id: crypto.randomUUID(), date: ctx.data.dashboard.date, time: 'Şimdi', authorId: 'ada', projectId: ctx.data.projects[0].id, body: value });
      ctx.refresh(); ctx.focus('#journal-input'); ctx.toast('Bugünün günlüğüne eklendi.');
    });
    input.control.addEventListener('input', () => input.control.setCustomValidity(''));
    ctx.body.append(navigation, form);
  }
});
