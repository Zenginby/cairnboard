import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, button, field, lockMessage, loadData, setupUI, renderState } from '../_shared/app-ui.js';

let data;
let fixtures;
let page;
let pageFixture;
let ui;
let state = 'full';
let sequence = 0;
const animations = new Set();
const easing = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const roleFor = (record) => data.columns.find((column) => column.id === record.column)?.role;
const nameFor = (project) => state === 'long' ? data.longText.projectName : project.name;
const summaryFor = (project) => data.projectSummaries.find((item) => item.projectId === project.id) || { description: '', noteCount: 0, completedArchive: 0 };
const copy = {
  empty: ['Henüz bir proje yok', 'Kartlarını ve notlarını toplayacağın projeye bir ad ver.', 'Proje ekle'],
  loading: ['Projeler yükleniyor', 'Proje kutuları ve kart sayıları hazırlanıyor.'],
  error: ['Projeler yüklenemedi', 'projects.yml okunamadı. Dosya yerinde mi bak, sonra yeniden dene.'],
};

function animate(node, frames, options) {
  const animation = node.animate(frames, options);
  animations.add(animation);
  animation.finished.catch(() => {}).finally(() => animations.delete(animation));
}
function stopAnimations() {
  animations.forEach((animation) => animation.cancel());
  animations.clear();
}
function entrance(node, delay = 0) {
  const less = lessMotion();
  animate(node, less ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(var(--motion-distance-base))' }, { opacity: 1, transform: 'none' }], { duration: tokenTime(less ? '--motion-duration-quick' : '--motion-duration-fast'), delay: less ? 0 : delay, easing: easing('--motion-ease-spring'), fill: 'backwards' });
}
function svgNode(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}
// Same ring as the home page's project boxes: a masked arc revealed in two halves on first load.
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
function projectBox(project) {
  const summary = summaryFor(project);
  const records = data.cards.filter((record) => record.projectId === project.id);
  const completed = records.filter((record) => roleFor(record) === 'done').length + summary.completedArchive;
  const total = records.length + summary.completedArchive;
  const node = el('a', 'box panel project-box box--interactive');
  node.href = `../project/?project=${encodeURIComponent(project.id)}`;
  node.dataset.project = project.id;
  node.style.setProperty('--project-wash', `var(--color-tone-${project.tone}-bg)`);
  node.style.setProperty('--project-ink', `var(--color-tone-${project.tone}-text)`);
  node.style.setProperty('--project-tone', `var(--color-tone-${project.tone})`);
  const heading = el('h3', 'project-name', nameFor(project));
  heading.id = `project-${project.id}`;
  node.setAttribute('aria-labelledby', heading.id);
  const headingCopy = el('div', 'project-heading');
  const notes = summary.noteCount + data.notes.filter((note) => note.projectId === project.id && !fixtures.notes.some((item) => item.id === note.id)).length;
  headingCopy.append(heading, el('p', 'project-subtitle', [summary.description, `${notes} not`].filter(Boolean).join(', ')));
  const top = el('div', 'project-top');
  top.append(headingCopy, progressRing(completed, total));
  const stat = el('p', 'project-stat');
  stat.append(el('strong', 'counter', `${completed}/${total} kart`), document.createTextNode('panoda bitti'));
  const focus = records.find((record) => roleFor(record) !== 'done');
  const focusText = focus ? (state === 'long' ? `${focus.title} — ${data.longText.title}` : focus.title) : 'Bu projede açık kart yok.';
  node.append(top, stat, el('p', 'project-focus', focusText));
  return node;
}
function render() {
  if (!data) return;
  stopAnimations();
  const sections = $('#project-sections');
  sections.replaceChildren();
  page.groups.forEach((group) => {
    const projects = data.projects.filter((project) => (page.status[project.id] || 'active') === group.id);
    const section = el('section', `project-section project-section--${group.id}`);
    const heading = el('h2', 'project-section-title');
    heading.id = `group-${group.id}`;
    heading.append(document.createTextNode(group.label), el('span', 'project-section-count counter', String(projects.length)));
    section.setAttribute('aria-labelledby', heading.id);
    const grid = el('div', 'project-grid');
    projects.forEach((project) => grid.append(projectBox(project)));
    if (!projects.length) grid.append(el('p', 'muted project-empty', group.id === 'archived' ? 'Arşivde proje yok. Biten projeler buraya taşınır.' : 'Bu bölümde proje yok.'));
    section.append(heading, grid);
    sections.append(section);
  });
  const active = data.projects.filter((project) => (page.status[project.id] || 'active') === 'active').length;
  $('#projects-summary').textContent = `${data.projects.length} proje · ${active} aktif`;
  const locked = state === 'locked';
  $('#add-project').disabled = locked;
  const lock = $('#projects-lock');
  lock.hidden = !locked;
  if (locked) {
    const message = lockMessage();
    lock.replaceChildren(...message.childNodes);
    lock.lastChild.textContent = 'claude proje listesini güncelliyor. Kilit kalkana kadar proje eklenemez.';
    $('#add-project').setAttribute('aria-describedby', 'projects-lock');
  } else $('#add-project').removeAttribute('aria-describedby');
}
function animateFirstLoad() {
  const limit = Number(easing('--motion-stagger-max-items'));
  document.querySelectorAll('#project-sections .project-box').forEach((box, index) => entrance(box, index < limit ? index * tokenTime('--motion-duration-stagger') : 0));
  if (lessMotion()) return;
  document.querySelectorAll('.ring-reveal').forEach((rect) => animate(rect, [{ transform: 'rotate(0turn)' }, { transform: 'rotate(.5turn)' }], { duration: tokenTime('--motion-duration-fast'), delay: rect.classList.contains('ring-reveal--second') ? tokenTime('--motion-duration-fast') : 0, easing: easing('--motion-ease-in-out'), fill: 'backwards' }));
}
function toneSwatches() {
  const set = el('fieldset', 'tone-picker');
  set.append(el('legend', 'type-label', 'Ton'));
  const used = new Set(data.projects.map((project) => project.tone));
  const free = [1, 2, 3, 4, 5, 6, 7, 8].find((tone) => !used.has(tone)) || (data.projects.length % 8) + 1;
  const row = el('div', 'tone-swatches');
  for (let tone = 1; tone <= 8; tone++) {
    const label = el('label', 'tone-swatch');
    label.style.setProperty('--swatch', `var(--color-tone-${tone})`);
    label.style.setProperty('--swatch-bg', `var(--color-tone-${tone}-bg)`);
    const input = el('input');
    input.type = 'radio';
    input.name = 'project-tone';
    input.value = String(tone);
    input.checked = tone === free;
    label.append(input, el('span', 'sr-only', `Ton ${tone}, ${page.toneNames[tone - 1]}`));
    label.title = `Ton ${tone}, ${page.toneNames[tone - 1]}`;
    row.append(label);
  }
  set.append(row, el('p', 'type-label muted', 'Ton yalnız ayırt etmek içindir; bir anlam taşımaz.'));
  return set;
}
function addProject(instant = false) {
  if (state === 'locked') { ui.announce('claude proje listesini güncelliyor. Kilit kalkana kadar proje eklenemez.'); return; }
  const name = field('Ad');
  name.control.required = true;
  name.control.maxLength = 60;
  name.control.autocomplete = 'off';
  const description = field('Kısa açıklama');
  description.control.maxLength = 80;
  description.control.placeholder = 'Randevular, alışveriş ve ev işleri';
  const error = el('p', 'field-error type-label');
  error.id = 'project-name-error';
  error.hidden = true;
  name.wrapper.append(error);
  const tones = toneSwatches();
  ui.open('Proje ekle', [name.wrapper, description.wrapper, tones], () => {
    const value = name.control.value.trim();
    const problem = !value ? 'Bir ad yaz.' : data.projects.some((project) => project.name.toLocaleLowerCase('tr') === value.toLocaleLowerCase('tr')) ? 'Bu adda bir proje zaten var.' : '';
    error.textContent = problem;
    error.hidden = !problem;
    name.control.setAttribute('aria-invalid', String(Boolean(problem)));
    if (problem) {
      name.control.setAttribute('aria-describedby', error.id);
      name.control.focus();
      return false;
    }
    const id = `proje-${crypto.randomUUID().slice(0, 8)}`;
    const tone = Number(tones.querySelector('input:checked').value);
    data.projects.push({ id, name: value, tone });
    data.projectSummaries.push({ projectId: id, description: description.control.value.trim(), noteCount: 0, completedArchive: 0 });
    page.status[id] = 'active';
    if (state === 'empty') setState('full');
    else render();
    const box = document.querySelector(`[data-project="${id}"]`);
    entrance(box);
    requestAnimationFrame(() => box.focus({ preventScroll: false }));
    ui.announce(`${value} projesi Aktif bölümüne eklendi.`);
  }, instant, 'Projeyi ekle');
  name.control.addEventListener('input', () => { error.hidden = true; name.control.removeAttribute('aria-invalid'); });
}
function setState(value) {
  state = value;
  if (value === 'empty') { data.projects = []; data.cards = []; }
  $('#prototype-state').value = value;
  renderState(value, () => setState('full'), (event) => addProject(event?.detail === 0), copy);
  render();
}
document.documentElement.addEventListener('motionchange', () => { if (lessMotion()) stopAnimations(); });
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (lessMotion()) stopAnimations(); });
async function start() {
  try {
    const [loaded, response] = await Promise.all([loadData('../_shared/workspace.json'), fetch('data.json')]);
    if (!response.ok) throw new Error('Page data unavailable');
    data = loaded;
    page = await response.json();
    fixtures = structuredClone(data);
    pageFixture = structuredClone(page);
    ui = setupUI(data, () => render(), (instant) => ui.create('card', instant));
    $('#add-project').addEventListener('click', (event) => addProject(event.detail === 0));
    $('#prototype-state').addEventListener('change', (event) => { Object.assign(data, structuredClone(fixtures)); page = structuredClone(pageFixture); setState(event.target.value); });
    $('#reload').addEventListener('click', () => {
      page.status['okuma-listesi'] = 'active';
      setState('full');
      $('#main').focus();
      ui.announce('Güncel proje listesi yüklendi. Okuma listesi Aktif bölümüne geçti.');
    });
    $('#conflict-diff').addEventListener('click', (event) => ui.open('Dosyadaki fark', [el('p', 'muted', 'projects.yml · dışarıdaki değişiklik'), el('p', 'type-code', '− okuma-listesi: beklemede'), el('p', 'type-code', '+ okuma-listesi: aktif'), el('p', '', 'Yeniden yükle, dışarıdaki sürümü bu oturumda uygular.')], null, event.detail === 0));
    document.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'p' || event.ctrlKey || event.metaKey || event.altKey || $('#editor').open || event.target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], #theme-panel')) return;
      event.preventDefault();
      addProject(true);
    });
    setState('full');
    animateFirstLoad();
  } catch {
    if (!$('#state-content')) return;
    renderState('error', start, null, copy);
  }
}
start();
