import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, button, projectChip, lockMessage, field, loadData, setupUI, renderState } from '../_shared/app-ui.js';

const copy = {
  empty: ['Çalışma alanında iş yok', 'Yapacağın işi bir karta yaz; proje kutusunda görünsün.', 'Kartı ekle'],
  loading: ['Günün özeti hazırlanıyor', 'Süren işler, son notlar ve günlük kayıtları sayılıyor.'],
  error: ['Günün özeti açılamadı', 'Veri klasörüne erişimi kontrol et, sonra ana sayfayı yeniden yükle.'],
};
let data;
let fixtures;
let ui;
let state = 'full';
let selectedProjects = new Set();
let sequence = 0;
let journalDraft = '';
const animations = new Set();
const preferenceKey = 'home-projects';
const featuredKey = 'home-featured';
const kindNames = { note: 'Not', wiki: 'Wiki', research: 'Araştırma' };
const titleFor = (record, index = 0) => state === 'long' ? `${record.title} — ${index % 2 ? data.longText.english : data.longText.title}` : record.title;
const projectFor = (record) => {
  const project = data.projects.find((item) => item.id === record.projectId);
  return state === 'long' ? { ...project, name: data.longText.projectName } : project;
};
const roleFor = (record) => data.columns.find((column) => column.id === record.column).role;
const date = () => new Date(`${data.dashboard.date}T12:00:00`);
const dayLabel = () => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' }).format(date());
const summaryFor = (project) => data.projectSummaries.find((item) => item.projectId === project.id);
function animate(node, frames, options) {
  const animation = node.animate(frames, options);
  animations.add(animation);
  animation.finished.catch(() => {}).finally(() => animations.delete(animation));
}
function stopAnimations() {
  animations.forEach((animation) => animation.cancel());
  animations.clear();
}
function box(title, className, href) {
  const node = el(href ? 'a' : 'section', `box stack panel ${className}${href ? ' box--interactive' : ''}`);
  if (href) node.href = href;
  const header = el('div', 'row panel-header');
  const heading = el('h2', '', title);
  heading.id = `heading-${++sequence}`;
  node.setAttribute('aria-labelledby', heading.id);
  header.append(heading);
  node.append(header);
  return { node, header };
}
function link(text, href, className = 'type-label') {
  const node = el('a', className, text);
  node.href = href;
  return node;
}
function dot(tone) {
  const node = el('span', 'tone-dot');
  node.setAttribute('aria-hidden', 'true');
  node.style.setProperty('--dot-color', `var(--color-${tone})`);
  return node;
}
function readFeatured() {
  try { return localStorage.getItem(featuredKey); } catch { return null; }
}
function saveFeatured(value) {
  try { localStorage.setItem(featuredKey, value); } catch { /* The choice still holds until the page reloads. */ }
}
function saveProjects() {
  try { localStorage.setItem(preferenceKey, JSON.stringify([...selectedProjects])); } catch { /* The selection still works in memory. */ }
}
function readProjects() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey));
    if (Array.isArray(saved)) {
      const known = saved.filter((id) => data.projects.some((project) => project.id === id));
      // A saved choice that names only projects that no longer exist is stale, not a wish to hide every project.
      if (known.length || !saved.length) return new Set(known);
    }
  } catch { /* Use the fixture defaults when storage is unavailable or malformed. */ }
  return new Set(data.dashboard.defaultProjects);
}
function setPickerOpen(open, instant = false, restore = false) {
  const panel = $('#project-menu');
  panel.classList.toggle('is-instant', instant);
  panel.classList.toggle('is-open', open);
  panel.inert = !open;
  panel.hidden = !open;
  $('#project-trigger').setAttribute('aria-expanded', String(open));
  if (open) {
    pickerSummary();
    // A filter field only earns focus where typing is cheap; on touch screens the keyboard would cover the list.
    const filter = panel.querySelector('.picker-filter');
    (filter && matchMedia('(pointer: fine)').matches ? filter : panel.querySelector('.picker-token input')).focus({ preventScroll: true });
  }
  else if (restore) $('#project-trigger').focus();
}
// The picker shows each project as a token in its own colour: chosen tokens are filled with the project's wash, the
// rest wait as dashed outlines. The trigger carries a little stack of the chosen colours and a count.
function pickerSummary() {
  const trigger = $('#project-trigger');
  if (!trigger) return;
  const chosen = data.projects.filter((project) => selectedProjects.has(project.id));
  const stack = el('span', 'picker-stack');
  stack.setAttribute('aria-hidden', 'true');
  chosen.slice(0, 4).forEach((project) => { const swatch = el('span', 'picker-swatch'); swatch.style.setProperty('--swatch', `var(--color-tone-${project.tone})`); stack.append(swatch); });
  if (!chosen.length) stack.append(el('span', 'picker-swatch is-empty'));
  trigger.replaceChildren(stack, el('span', '', 'Projeler'), el('span', 'picker-count counter', `${chosen.length}/${data.projects.length}`));
  trigger.setAttribute('aria-label', `Projeleri seç, ${chosen.length} / ${data.projects.length} gösteriliyor`);
  const meter = $('#picker-meter');
  if (meter) meter.textContent = `${chosen.length} / ${data.projects.length} gösteriliyor`;
}
function projectPicker() {
  const wrapper = el('div', 'project-picker');
  const trigger = button('', (event) => setPickerOpen($('#project-menu').inert, event.detail === 0), 'picker-trigger');
  trigger.id = 'project-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', 'project-menu');
  trigger.setAttribute('aria-expanded', 'false');
  const panel = el('div', 'project-menu');
  panel.id = 'project-menu';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Ana sayfada görünen projeler');
  panel.inert = true;
  panel.hidden = true;
  // Clicking a token's label is not a focusable target, so without this the browser would move focus to <main> and
  // the focus-out rule below would close the panel before the click reached the checkbox.
  panel.tabIndex = -1;
  const list = el('fieldset', 'project-checks');
  const legend = el('legend', 'picker-legend');
  const meter = el('span', 'picker-meter counter'); meter.id = 'picker-meter';
  legend.append(el('span', '', 'Ana sayfada görünen projeler'), meter);
  list.append(legend);
  const tokens = el('div', 'picker-tokens');
  data.projects.forEach((project) => {
    const label = el('label', 'picker-token');
    label.style.setProperty('--token-ink', `var(--color-tone-${project.tone}-text)`);
    label.style.setProperty('--token-wash', `var(--color-tone-${project.tone}-bg)`);
    label.style.setProperty('--token-dot', `var(--color-tone-${project.tone})`);
    const input = el('input', 'sr-only');
    input.type = 'checkbox';
    input.value = project.id;
    input.checked = selectedProjects.has(project.id);
    input.addEventListener('change', () => {
      if (input.checked) selectedProjects.add(project.id);
      else selectedProjects.delete(project.id);
      saveProjects();
      renderProjects();
      pickerSummary();
      ui.announce(`${selectedProjects.size} proje gösteriliyor.`);
    });
    const mark = el('span', 'picker-mark');
    mark.setAttribute('aria-hidden', 'true');
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('viewBox', '0 0 12 12');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm3 6.2 2 2L9 4');
    check.append(path); mark.append(check);
    label.append(input, mark, el('span', 'picker-name', state === 'long' ? data.longText.projectName : project.name));
    tokens.append(label);
  });
  list.append(tokens);
  // Many projects: a filter narrows the tokens and the token area scrolls instead of growing without end.
  let filter = null;
  if (data.projects.length > 6) {
    filter = el('input', 'input picker-filter');
    filter.type = 'search';
    filter.placeholder = 'Proje süz…';
    filter.setAttribute('aria-label', 'Projeleri adına göre süz');
    filter.setAttribute('aria-controls', 'picker-tokens');
    tokens.id = 'picker-tokens';
    const none = el('p', 'picker-none muted type-label', 'Bu adla proje yok.');
    none.hidden = true;
    filter.addEventListener('input', () => {
      const query = filter.value.trim().toLocaleLowerCase('tr');
      let shown = 0;
      tokens.querySelectorAll('.picker-token').forEach((token) => {
        const match = !query || token.textContent.toLocaleLowerCase('tr').includes(query);
        token.hidden = !match;
        if (match) shown += 1;
      });
      none.hidden = shown > 0;
    });
    list.append(none);
  }
  const choose = (ids) => {
    selectedProjects = new Set(ids);
    panel.querySelectorAll('input').forEach((input) => { input.checked = selectedProjects.has(input.value); });
    saveProjects();
    renderProjects();
    pickerSummary();
    ui.announce(`${selectedProjects.size} proje gösteriliyor.`);
  };
  const actions = el('div', 'picker-actions');
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Hızlı seçim');
  actions.append(
    button('Hepsi', () => choose(data.projects.map((project) => project.id)), 'picker-quick'),
    button('Varsayılan', () => choose(data.dashboard.defaultProjects), 'picker-quick'),
    button('Hiçbiri', () => choose([]), 'picker-quick'));
  panel.append(...(filter ? [filter] : []), list, actions);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPickerOpen(false, true, true); }
  });
  wrapper.append(trigger, panel);
  queueMicrotask(pickerSummary);
  return wrapper;
}
function hero() {
  const node = el('section', 'box stack panel hero');
  node.setAttribute('aria-labelledby', 'workspace-title');
  const weekday = new Intl.DateTimeFormat('tr-TR', { weekday: 'long' }).format(date());
  const title = el('h1', 'workspace-title', data.workspace);
  title.id = 'workspace-title';
  const counts = el('p', 'hero-summary');
  counts.append('Bugün ', el('strong', '', `${data.cards.filter((record) => roleFor(record) === 'doing').length} iş sürüyor`), ', ', el('strong', '', `${data.cards.filter((record) => roleFor(record) === 'todo').length} iş sırada`), '.');
  const pills = el('div', 'row hero-pills');
  const lastEntry = link(`Son kayıt ${dayLabel()}: ${data.journal.length} iş`, '#journal', 'button journal-pill');
  lastEntry.prepend(dot('done'));
  pills.append(lastEntry, projectPicker());
  const content = el('div', 'hero-copy');
  content.append(el('p', 'hero-date', `${dayLabel()}, ${weekday}`), title, counts, el('p', 'hero-date', `Son güncelleme: ${dayLabel()} ${data.dashboard.updated}`));
  node.append(content, pills);
  return node;
}
function calendar() {
  const { node, header } = box('Günlük', 'calendar-box', '#journal');
  header.append(el('span', 'type-label muted', `${new Set(data.dashboard.journalDays).size} gün`));
  node.append(el('p', 'muted type-label', 'Hangi gün ne yapıldı'));
  const grid = el('div', 'month-grid');
  const month = data.dashboard.date.slice(0, 7);
  const days = new Set(data.dashboard.journalDays.filter((value) => value.startsWith(month)));
  const monthName = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(date());
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `${monthName}: ${days.size} günde kayıt var`);
  const first = new Date(date().getFullYear(), date().getMonth(), 1);
  for (let index = 0; index < (first.getDay() + 6) % 7; index++) grid.append(el('span', 'calendar-blank'));
  const total = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let day = 1; day <= total; day++) {
    const value = `${month}-${String(day).padStart(2, '0')}`;
    const cell = el('span', `calendar-day${days.has(value) ? ' has-entry' : ''}${value === data.dashboard.date ? ' is-today' : ''}`);
    cell.title = `${day} ${monthName}${days.has(value) ? ' · kayıt var' : ''}`;
    grid.append(cell);
  }
  [...grid.children].forEach((child) => child.setAttribute('aria-hidden', 'true'));
  node.append(grid);
  return node;
}
function svgNode(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}
function progressRing(done, total) {
  const svg = svgNode('svg', { viewBox: '0 0 64 64', class: 'progress-ring', 'aria-hidden': 'true' });
  const id = `ring-${++sequence}`;
  const defs = svgNode('defs');
  const mask = svgNode('mask', { id, class: 'ring-mask' });
  for (const [half, clipX, revealX] of [['first', 32, 0], ['second', 0, 32]]) {
    const clip = svgNode('clipPath', { id: `${id}-${half}` });
    clip.append(svgNode('rect', { x: clipX, y: 0, width: 32, height: 64 }));
    defs.append(clip);
    const group = svgNode('g', { 'clip-path': `url(#${id}-${half})` });
    group.append(svgNode('rect', { x: revealX, y: 0, width: 32, height: 64, class: `ring-reveal ring-reveal--${half}` }));
    mask.append(group);
  }
  defs.append(mask);
  const arc = svgNode('g', { mask: `url(#${id})` });
  arc.append(svgNode('circle', { cx: 32, cy: 32, r: 26, pathLength: 100, class: 'ring-arc' }));
  svg.append(defs, svgNode('circle', { cx: 32, cy: 32, r: 26, class: 'ring-track' }), arc);
  svg.style.setProperty('--ring-progress', String(total ? done / total * 100 : 0));
  return svg;
}
function renderProjects() {
  const grid = $('#project-grid');
  grid.replaceChildren();
  const shown = data.projects.filter((project) => selectedProjects.has(project.id));
  // You choose which project leads (the star on each box); until you do, the one with the most open cards leads.
  // The lead box is wider and lists what comes after the next card; every box keeps its colour and progress ring.
  const openCount = (project) => data.cards.filter((record) => record.projectId === project.id && roleFor(record) !== 'done').length;
  const chosen = readFeatured();
  const featured = chosen === 'none' || shown.length < 2 ? null
    : shown.find((project) => project.id === chosen) || shown.reduce((best, project) => (openCount(project) > openCount(best) ? project : best), shown[0]);
  shown.sort((a, b) => (b === featured) - (a === featured)).forEach((project) => {
    const summary = summaryFor(project);
    const records = data.cards.filter((record) => record.projectId === project.id);
    const completed = records.filter((record) => roleFor(record) === 'done').length + summary.completedArchive;
    const total = records.length + summary.completedArchive;
    const lead = project === featured;
    const { node, header } = box(state === 'long' ? data.longText.projectName : project.name, `project-box${lead ? ' project-box--featured' : ''}`, `../project/?project=${encodeURIComponent(project.id)}`);
    node.style.setProperty('--project-wash', `var(--color-tone-${project.tone}-bg)`);
    node.style.setProperty('--project-ink', `var(--color-tone-${project.tone}-text)`);
    node.style.setProperty('--project-tone', `var(--color-tone-${project.tone})`);
    if (!grid.children.length) node.id = 'projects';
    // The box grows into the project page's cover (cross-document view transition): only the clicked box carries
    // the shared name, so a page restored from the back/forward cache never has two.
    node.addEventListener('click', () => {
      document.querySelectorAll('.project-box').forEach((other) => other.style.removeProperty('view-transition-name'));
      node.style.setProperty('view-transition-name', 'project-cover');
    });
    const additionalNotes = data.notes.filter((note) => note.projectId === project.id && !fixtures.notes.some((item) => item.id === note.id)).length;
    const subtitle = el('p', 'project-subtitle', `${summary.description}, ${summary.noteCount + additionalNotes} not`);
    const heading = header.firstElementChild;
    const copy = el('div', 'project-heading');
    copy.append(heading, subtitle);
    header.className = 'project-top';
    header.replaceChildren(copy, progressRing(completed, total));
    const stat = el('p', 'project-stat');
    stat.append(el('strong', 'counter', `${completed}/${total} kart`), document.createTextNode('panoda bitti'));
    const open = records.filter((record) => roleFor(record) !== 'done');
    const focusLine = el('p', 'project-focus', open[0] ? titleFor(open[0]) : 'Bu projede açık kart yok.');
    node.append(stat, focusLine);
    // The lead box has room for what comes after the next card.
    if (lead && open.length > 1) {
      const next = el('ul', 'project-next');
      open.slice(1, 3).forEach((record) => next.append(el('li', '', titleFor(record))));
      node.append(next);
    }
    // The box is a link, so the star sits beside it in a shared cell rather than inside it.
    const cell = el('div', `project-cell${lead ? ' project-cell--featured' : ''}`);
    const star = button('', () => {
      saveFeatured(lead ? 'none' : project.id);
      renderProjects();
      const again = document.querySelector(`.project-star[data-project="${project.id}"]`);
      again?.focus({ preventScroll: true });
      ui.announce(lead ? `${project.name} artık öne çıkmıyor.` : `${project.name} öne çıkarıldı.`);
    }, `project-star${lead ? ' is-on' : ''}`);
    star.dataset.project = project.id;
    star.setAttribute('aria-pressed', String(lead));
    star.setAttribute('aria-label', `Öne çıkar: ${project.name}`);
    star.title = lead ? 'Öne çıkarmayı kaldır' : 'Bu projeyi öne çıkar';
    const icon = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    icon.append(svgNode('path', { d: 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z' }));
    star.append(icon);
    cell.append(node, star);
    grid.append(cell);
  });
  if (!grid.children.length) {
    const empty = el('div', 'project-empty');
    empty.id = 'projects';
    empty.append(el('p', 'muted', 'Proje kutuları gizli. Görmek istediklerini seçebilirsin.'), button('Projeleri seç', (event) => setPickerOpen(true, event.detail === 0)));
    grid.append(empty);
  }
}
function move(record, instant) {
  const target = field('Hedef sütun', 'select');
  data.columns.forEach((column) => { const option = el('option', '', column.label); option.value = column.id; target.control.append(option); });
  target.control.value = record.column;
  ui.open('Kartı taşı', [el('p', '', record.title), target.wrapper], () => {
    const previous = data.columns.find((column) => column.id === record.column).label;
    record.column = target.control.value;
    render();
    const destination = data.columns.find((column) => column.id === record.column).label;
    ui.announce(`'${record.title}' kartı '${previous}' sütunundan '${destination}' sütununa taşındı.`);
    requestAnimationFrame(() => (document.getElementById(record.id) || $('#main')).focus());
  }, instant, 'Kartı taşı');
}
function ongoing() {
  const { node, header } = box('Sürüyor', 'ongoing');
  header.append(link('Panoda gör', '../board/', 'action-link'));
  const list = el('ul', 'summary-list');
  data.cards.filter((record) => roleFor(record) === 'doing').forEach((record, index) => {
    const item = el('li', 'ongoing-item');
    item.id = record.id;
    item.tabIndex = 0;
    const row = link('', '../board/', 'summary-row');
    row.addEventListener('click', (event) => { event.preventDefault(); ui.inspect({ ...record, title: titleFor(record, index) }, event.detail === 0); });
    const text = el('span', 'row-copy');
    const detail = el('span', 'row-detail');
    const review = record.column === 'review';
    const agent = ['claude', 'codex'].includes(record.assigneeId);
    detail.append(el('b', '', review ? 'Senden: ' : agent ? 'Şimdi: ' : 'Sonra: '), review ? 'İncele ve kısa bir geri bildirim bırak.' : agent ? `${record.assigneeId} kabul ölçütlerini doğruluyor.` : 'Kartın kalan ölçütlerini tamamla.');
    text.append(el('span', 'row-title', titleFor(record, index)), detail);
    const chip = projectChip(projectFor(record));
    const projectName = el('span', 'project-chip-name', chip.textContent);
    chip.replaceChildren(dot(`tone-${projectFor(record).tone}-text`), projectName);
    row.append(text, chip);
    item.append(row);
    const locked = state === 'locked' && record.id === 'card-2';
    if (locked) {
      const trigger = button('Kartı taşı…', () => {}, 'button button--quiet');
      trigger.disabled = true;
      const message = lockMessage();
      message.id = `${record.id}-lock`;
      trigger.setAttribute('aria-describedby', message.id);
      item.setAttribute('aria-describedby', message.id);
      item.append(message, trigger);
    }
    item.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'm' || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      if (locked) ui.announce('claude üzerinde çalışıyor. Kilit kalkana kadar taşınamaz.');
      else move(record, true);
    });
    list.append(item);
  });
  node.append(list);
  if (!list.children.length) node.append(el('p', 'muted', 'Şu an süren bir iş yok. Panodan bir kart seçebilirsin.'));
  return node;
}
function boardSummary() {
  const { node, header } = box('Pano', 'board-summary', '../board/');
  const archive = data.projectSummaries.reduce((sum, project) => sum + project.completedArchive, 0);
  header.append(el('span', 'type-label muted counter', `${data.cards.length + archive} kart`));
  node.append(el('p', 'muted type-label', 'Bütün projelerin şu anki durumu'));
  const bar = el('div', 'segmented-bar');
  bar.setAttribute('aria-hidden', 'true');
  const legend = el('ul', 'board-legend');
  data.columns.forEach((column) => {
    const count = data.cards.filter((record) => record.column === column.id).length + (column.role === 'done' ? archive : 0);
    const tone = column.id === 'review' ? 'tone-1' : { todo: 'planned', doing: 'doing', done: 'done' }[column.role];
    const segment = el('span', 'bar-segment');
    segment.style.setProperty('--segment-count', String(count));
    segment.style.setProperty('--segment-color', `var(--color-${tone})`);
    segment.hidden = count === 0;
    bar.append(segment);
    const label = el('li');
    label.append(dot(tone), document.createTextNode(column.label), el('b', 'counter', String(count)));
    legend.append(label);
  });
  node.append(bar, legend);
  return node;
}
function journalPreview(event) {
  event.preventDefault();
  ui.open(`${dayLabel()} günü yapılanlar`, data.journal.length ? data.journal.map((entry) => el('p', '', `${entry.time} · ${entry.body}`)) : [el('p', 'muted', 'Henüz kayıt yok. Bugüne ekle alanından başlayabilirsin.')], null, event.detail === 0);
}
function today() {
  const { node, header } = box(`${dayLabel()} günü yapılanlar`, 'today');
  node.id = 'journal';
  const open = link('Günü aç', '#journal', 'action-link');
  open.addEventListener('click', journalPreview);
  header.append(open);
  const list = el('ol', 'numbered-list');
  data.journal.forEach((entry) => {
    const row = el('li', 'numbered-row');
    row.dataset.entry = entry.id;
    row.append(el('span', '', entry.body));
    list.append(row);
  });
  if (!data.journal.length) node.append(el('p', 'muted', 'Bugünün günlüğü boş. Yaptığın bir işi aşağıya yaz.'));
  const form = el('form', 'row journal-form');
  const input = field('Bugüne ekle');
  input.control.placeholder = 'Bugün ne yaptın?';
  input.control.required = true;
  input.control.value = journalDraft;
  input.control.addEventListener('input', () => { journalDraft = input.control.value; input.control.setCustomValidity(''); });
  const save = el('button', 'button button--primary', 'Kaydı ekle');
  save.type = 'submit';
  form.append(input.wrapper, save);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.control.value.trim();
    if (!value) { input.control.setCustomValidity('Kısa bir not yaz.'); input.control.reportValidity(); return; }
    const entry = { id: crypto.randomUUID(), date: data.dashboard.date, time: new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date()), authorId: 'ada', body: value };
    data.journal.push(entry);
    if (!data.dashboard.journalDays.includes(entry.date)) data.dashboard.journalDays.push(entry.date);
    data.dashboard.updated = entry.time;
    journalDraft = '';
    render();
    $('#journal input').focus({ preventScroll: true });
    const row = [...document.querySelectorAll('[data-entry]')].find((item) => item.dataset.entry === entry.id);
    animate(row, lessMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(var(--motion-distance-base))' }, { opacity: 1, transform: 'none' }], { duration: tokenTime(lessMotion() ? '--motion-duration-quick' : '--motion-duration-fast'), easing: getComputedStyle(document.documentElement).getPropertyValue('--motion-ease-smooth-out').trim() });
    ui.announce('Bugünün günlüğüne eklendi.');
  });
  node.append(list, form);
  return node;
}
function noteBox(title, className, records, numbered = false) {
  const { node, header } = box(title, className);
  header.append(el('span', 'panel-count', `${records.length} ${className === 'research' ? 'belge' : 'kayıt'}`));
  if (className === 'research') node.id = 'research';
  if (className === 'recent') node.id = 'notes';
  if (!numbered) node.append(el('p', 'panel-subtitle', className === 'pinned' ? 'Elinin altında tuttuğun notlar ve sayfalar' : 'Son düzenlenen notların'));
  const list = el(numbered ? 'ol' : 'ul', numbered ? 'numbered-list' : 'summary-list');
  records.slice(0, 3).forEach((record, index) => {
    const row = el('li', numbered ? 'numbered-row' : 'summary-row note-row');
    const copy = el('div', 'row-copy stack');
    copy.append(button(titleFor(record, index), (event) => ui.inspect({ ...record, title: titleFor(record, index) }, event.detail === 0), 'text-button note-title'));
    if (!numbered) copy.append(el('p', 'row-detail excerpt', record.body));
    else copy.append(el('time', 'research-date', record.updated));
    row.append(copy);
    if (!numbered) row.append(el('span', 'chip', kindNames[record.kind]));
    list.append(row);
  });
  node.append(list);
  if (!records.length) node.append(el('p', 'muted', className === 'pinned' ? 'Elinin altında tutacağın bir notu sayfasından sabitle.' : className === 'research' ? 'Kaydedilen araştırmalar burada görünecek.' : 'Aklındaki notu N tuşuyla yaz.'));
  return node;
}
function render() {
  if (!data) return;
  stopAnimations();
  const projects = el('div', 'project-grid');
  projects.id = 'project-grid';
  $('#dashboard').replaceChildren(hero(), calendar(), projects, ongoing(), boardSummary(), noteBox('Sabitlenenler', 'pinned', data.notes.filter((note) => note.pinned)), noteBox('Son notlar', 'recent', data.notes.filter((note) => note.kind === 'note')), noteBox('Araştırmalar', 'research', data.notes.filter((note) => note.kind === 'research'), true), today());
  renderProjects();
}
function animateFirstLoad() {
  const computed = getComputedStyle(document.documentElement);
  const limit = Number(computed.getPropertyValue('--motion-stagger-max-items'));
  // A project box enters together with its star, so the star never shows before its box.
  document.querySelectorAll('#dashboard .panel').forEach((panel, index) => {
    animate(panel.closest('.project-cell') || panel, lessMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(var(--motion-distance-base))' }, { opacity: 1, transform: 'none' }], { duration: tokenTime(lessMotion() ? '--motion-duration-quick' : '--motion-duration-fast'), delay: lessMotion() || index >= limit ? 0 : index * tokenTime('--motion-duration-stagger'), easing: computed.getPropertyValue('--motion-ease-spring').trim(), fill: 'backwards' });
  });
  if (lessMotion()) return;
  document.querySelectorAll('.ring-reveal').forEach((rect) => animate(rect, [{ transform: 'rotate(0turn)' }, { transform: 'rotate(.5turn)' }], { duration: tokenTime('--motion-duration-fast'), delay: rect.classList.contains('ring-reveal--second') ? tokenTime('--motion-duration-fast') : 0, easing: computed.getPropertyValue('--motion-ease-in-out').trim(), fill: 'backwards' }));
}
function setState(value) {
  state = value;
  if (value === 'empty') {
    data.cards = []; data.notes = []; data.journal = []; data.dashboard.journalDays = [];
    data.projectSummaries.forEach((project) => { project.completedArchive = 0; project.noteCount = 0; });
  }
  $('#prototype-state').value = value;
  renderState(value, () => setState('full'), () => ui.create('card'), copy);
  render();
}
document.addEventListener('pointerdown', (event) => { if ($('#project-menu') && !event.target.closest('.project-picker')) setPickerOpen(false); });
document.addEventListener('focusin', (event) => { if ($('#project-menu') && !event.target.closest('.project-picker')) setPickerOpen(false); });
document.documentElement.addEventListener('motionchange', () => { if (lessMotion()) stopAnimations(); });
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (lessMotion()) stopAnimations(); });
async function start() {
  try {
    data = await loadData();
    fixtures = structuredClone(data);
    selectedProjects = readProjects();
    ui = setupUI(data, () => { if (state === 'empty') setState('full'); else render(); }, (instant) => ui.create('card', instant));
    $('#prototype-state').addEventListener('change', (event) => { Object.assign(data, structuredClone(fixtures)); journalDraft = ''; setState(event.target.value); });
    $('#reload').addEventListener('click', () => { data.cards[0].title += ' ve sonucu günlüğe yaz'; setState('full'); $('#main').focus(); ui.announce('Dosyanın dışarıdaki sürümü yüklendi.'); });
    setState('full');
    animateFirstLoad();
    if (location.hash) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'instant', block: 'start' }));
  } catch {
    renderState('error', start, () => {}, copy);
  }
}
start();
addEventListener('pageshow', () => document.querySelectorAll('.project-box').forEach((box) => box.style.removeProperty('view-transition-name')));
