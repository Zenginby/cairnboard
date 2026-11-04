import { startDocument, section, el, field, link, projectChip } from '../_shared/doc-frame.js';

const requested = new URLSearchParams(location.search).get('date');
const validDate = /^\d{4}-\d{2}-\d{2}$/.test(requested || '') && Number.isFinite(new Date(`${requested}T12:00:00`).getTime());
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
  markdown: bodyFor,
  firstStep(ctx) { ctx.setState('full'); ctx.focus('#journal-input'); },
  emptyLabel: 'Bugüne ekle',
  reload(ctx) { if (records(ctx)[0]) records(ctx)[0].body += ' Birlikte yeniden gözden geçirilecek.'; },
  sidebar(ctx) {
    const dates = [...new Set([...ctx.data.journal.map((entry) => entry.date), date])].sort().reverse();
    return { groups: [{ title: 'Günlük', entries: [{ title: 'Ay görünümü', href: `../journal/?month=${date.slice(0, 7)}` }] }, ...[...new Set(dates.map((date) => date.slice(0, 7)))].map((month) => ({ title: new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00`)), entries: dates.filter((day) => day.startsWith(month)).map((day) => ({ title: day, href: `../journal-day/?date=${day}`, current: date === day })) }))] };
  },
  render(ctx) {
    ctx.header(title(dateValue), `journal/${date}.md`, () => `# ${title(dateValue)}\n\n${bodyFor(ctx)}`);
    ctx.body.replaceChildren();
    if (!records(ctx).length) ctx.body.append(el('p', 'muted', 'Bu gün için henüz kayıt yok. Ay görünümünden kayıtlı bir gün seçebilirsiniz.'));
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
    const save = el('button', 'button button--primary', 'Bugüne ekle'); save.type = 'submit'; save.disabled = ctx.state === 'locked';
    const today = title(new Date(`${ctx.data.dashboard.date}T12:00:00`));
    form.append(el('p', 'type-label muted', `Yeni kayıt ${today} gününe eklenecek.`), input.wrapper, save);
    if (ctx.state === 'locked') form.append(el('p', 'type-label muted', 'claude üzerinde çalışıyor. Kilit kalkana kadar kayıt eklenemez.'));
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (!ctx.canWrite()) return;
      const value = input.control.value.trim();
      if (!value) { input.control.setCustomValidity('Kısa bir not yazın.'); input.control.reportValidity(); return; }
      ctx.data.journal.push({ id: crypto.randomUUID(), date: ctx.data.dashboard.date, time: 'Şimdi', authorId: 'ada', projectId: ctx.data.projects[0].id, body: value });
      ctx.refresh(); ctx.focus('#journal-input'); ctx.toast('Bugünün günlüğüne eklendi.');
    });
    input.control.addEventListener('input', () => input.control.setCustomValidity(''));
    ctx.body.append(navigation, form);
  }
});
