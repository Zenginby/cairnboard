import { startDocument, el, button, link, projectChip, journalGroups, inline } from '../_shared/doc-frame.js';
import { journalTypes, sectionHeading, sectionMarkdown, sectionProjectId } from '../_shared/journal.js';
import { journalFields } from '../_shared/journal-form.js';

let month = new Date(2026, 10, 1);
let selected = '';
let projectFilter = new URLSearchParams(location.search).get('project') || '';
let selectDay = () => {};
let daysWithEntries = [];
const dateKey = (day) => `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const monthLabel = () => { const value = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(month); return value[0].toLocaleUpperCase('tr') + value.slice(1); };
// A section's project is the first [[project-id]] link in its heading or items; '' when there is none.
const projectId = (ctx, entry) => sectionProjectId(entry, ctx.data.projects);
function addToday(ctx) {
  if (!ctx.canWrite()) return;
  const fields = journalFields(ctx.data, projectFilter);
  ctx.ui.open('Bugüne iş ekle', fields.nodes, () => {
    if (!ctx.canWrite()) return false;
    const value = fields.read();
    if (!value) return false;
    ctx.data.journal.push({ id: crypto.randomUUID(), date: ctx.data.dashboard.date, ...value });
    month = new Date(`${ctx.data.dashboard.date}T12:00:00`); month.setDate(1); selected = ctx.data.dashboard.date;
    ctx.setState('full'); ctx.toast('Bugünün günlüğüne eklendi.'); ctx.focus('#add-today');
  }, false, 'İşi ekle');
}
startDocument({
  copy: {
    empty: ['Takvimde günlük kaydı yok', 'Bugün yaptığın bir işi günlüğe yaz.', 'Kaydı ekle'],
    loading: ['Günlük takvimi hazırlanıyor', 'Kayıt bulunan günler ve proje bilgileri okunuyor.'],
    error: ['Günlük takvimi açılamadı', 'journal/ klasörüne erişimi kontrol et, sonra takvimi yeniden yükle.'],
  },
  firstStep: addToday,
  reset() { selected = ''; },
  reload(ctx) { ctx.data.journal[0].items.push({ text: 'Tarihi takvimden doğruladım.' }); },
  sidebar(ctx) {
    return { groups: journalGroups(ctx, { month: dateKey(1).slice(0, 7) }) };
  },
  prepare(ctx) {
    const query = new URLSearchParams(location.search).get('month');
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(query || '')) month = new Date(`${query}-01T12:00:00`);
    if (!ctx.data.projects.some((project) => project.id === projectFilter)) projectFilter = '';
  },
  // Sayfa içeriği: the month, then every day that has entries; choosing a day opens it in the calendar.
  toc() {
    const dayName = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
    return {
      items: [{ title: monthLabel(), id: 'calendar-month', level: 2 }, ...daysWithEntries.map((date) => ({ title: dayName.format(new Date(`${date}T12:00:00`)), id: `day-${date}`, level: 3, select: () => selectDay(date) }))],
      current: () => (selected ? `day-${selected}` : 'calendar-month')
    };
  },
  render(ctx) {
    ctx.header('Günlük', 'journal/', () => [...new Set(ctx.data.journal.map((entry) => entry.date))].sort().map((date) => `# ${date}\n\n${ctx.data.journal.filter((entry) => entry.date === date).map(sectionMarkdown).join('\n\n')}`).join('\n\n'));
    const toolbar = el('div', 'row doc-toolbar');
    const add = button('Bugüne iş ekle', () => addToday(ctx), 'button button--primary'); add.id = 'add-today'; add.disabled = ctx.state === 'locked'; toolbar.append(add);
    if (ctx.state === 'locked') toolbar.append(el('span', 'type-label muted', 'claude üzerinde çalışıyor.'));
    const calendar = el('section', 'calendar'); calendar.setAttribute('aria-label', 'Günlük takvimi');
    const navigation = el('div', 'calendar-navigation');
    const go = (offset) => { month = new Date(month.getFullYear(), month.getMonth() + offset, 1); selected = ''; ctx.refresh(); ctx.focus(offset < 0 ? '#previous-month' : '#next-month'); };
    const previous = button('‹', () => go(-1), 'button calendar-arrow'); previous.id = 'previous-month'; previous.setAttribute('aria-label', 'Önceki ay');
    const next = button('›', () => go(1), 'button calendar-arrow'); next.id = 'next-month'; next.setAttribute('aria-label', 'Sonraki ay');
    const title = el('h2', 'calendar-month', monthLabel()); title.id = 'calendar-month'; title.setAttribute('aria-live', 'polite'); navigation.append(previous, title, next); calendar.append(navigation);
    const filters = el('div', 'row calendar-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Projeye göre süz');
    [{ id: '', name: 'Tümü' }, ...ctx.data.projects.filter((project) => ctx.data.journal.some((entry) => projectId(ctx, entry) === project.id))].forEach((project) => {
      const chip = button(project.name, () => { projectFilter = project.id; selected = ''; ctx.refresh(); ctx.focus(`[data-project="${project.id}"]`); }, 'button calendar-filter');
      chip.dataset.project = project.id; chip.setAttribute('aria-pressed', String(projectFilter === project.id)); filters.append(chip);
    }); calendar.append(filters);
    const grid = el('table', 'calendar-grid'); grid.setAttribute('aria-labelledby', title.id);
    const head = el('thead'); const days = el('tr');
    ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].forEach((name) => { const cell = el('th', '', name); cell.scope = 'col'; days.append(cell); }); head.append(days); grid.append(head);
    daysWithEntries = [];
    const body = el('tbody'); const first = (month.getDay() + 6) % 7; const total = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const panel = el('div', 'calendar-panel'); panel.dataset.open = 'false'; panel.inert = true; panel.setAttribute('aria-hidden', 'true');
    const panelInner = el('div', 'calendar-panel-inner'); const panelContent = el('div', 'calendar-day-content'); panelInner.append(panelContent); panel.append(panelInner);
    const visible = (date) => ctx.data.journal.filter((entry) => entry.date === date && (!projectFilter || projectId(ctx, entry) === projectFilter));
    function show(date, instant = false) {
      selected = date;
      grid.querySelectorAll('button').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.date === date)));
      panelContent.replaceChildren();
      const heading = el('h3'); heading.append(link(date, `../journal-day/?date=${date}`)); panelContent.append(heading);
      visible(date).forEach((entry) => {
        const section = el('div', 'calendar-entry'); const meta = el('div', 'row');
        meta.append(el('strong', '', ctx.text(sectionHeading(entry))));
        const owner = ctx.data.projects.find((project) => project.id === projectId(ctx, entry));
        if (owner) meta.append(projectChip(owner));
        const list = el('ul');
        entry.items.forEach((item) => {
          const row = el('li');
          if (item.type) row.append(el('strong', '', `${journalTypes[item.type]}: `));
          inline(row, ctx.text(item.text), ctx.data); list.append(row);
        });
        section.append(meta, list); panelContent.append(section);
      });
      panelContent.append(link('Günün tam günlüğü', `../journal-day/?date=${date}`, 'action-link'));
      panel.classList.toggle('is-instant', instant); panel.dataset.open = 'true'; panel.inert = false; panel.setAttribute('aria-hidden', 'false');
      if (!instant) ctx.updateTOC();
    }
    selectDay = (date) => {
      show(date);
      const cell = grid.querySelector(`[data-date="${date}"]`);
      cell?.focus({ preventScroll: true });
      cell?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'less' ? 'auto' : 'smooth' });
    };
    for (let slot = 0; slot < Math.ceil((first + total) / 7) * 7; slot++) {
      if (slot % 7 === 0) body.append(el('tr'));
      const td = el('td'); body.lastElementChild.append(td);
      const day = slot - first + 1; if (day < 1 || day > total) continue;
      const date = dateKey(day); const count = visible(date).length;
      if (count) daysWithEntries.push(date);
      let cell;
      if (count) {
        cell = button('', (event) => show(date, event.detail === 0), 'calendar-day'); cell.dataset.date = date; cell.id = `day-${date}`;
        cell.setAttribute('aria-pressed', String(selected === date)); cell.setAttribute('aria-label', `${day} ${monthLabel()}, ${count} iş`);
        cell.append(el('span', '', String(day)), el('i', 'calendar-count', String(count)));
      } else cell = el('span', 'calendar-day', String(day));
      if (date === ctx.data.dashboard.date) { cell.classList.add('is-today'); cell.setAttribute('aria-current', 'date'); cell.setAttribute('aria-label', `${day} ${monthLabel()}, bugün, ${count} iş`); }
      td.append(cell);
    }
    grid.append(body); calendar.append(grid, panel);
    if (selected && visible(selected).length) show(selected, true);
    ctx.body.replaceChildren(toolbar, calendar);
  }
});
