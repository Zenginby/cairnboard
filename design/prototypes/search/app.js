import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, button, loadData, setupUI, renderState } from '../_shared/app-ui.js';
import { createSearch, searchFilters, searchRecords } from '../_shared/search-results.js';

let data;
let fixtures;
let ui;
let search;
let state = 'full';
let kind = 'all';
let lastQuery = '';
const recent = ['kabul ölçütleri', 'dar ekran', 'ajan'];
const copy = {
  empty: ['Aranacak bir şey yok', 'Bu çalışma alanında henüz not, kart ya da günlük kaydı yok. İlk notu eklece burada aranabilir.', 'İlk notu ekle'],
  loading: ['Dizin hazırlanıyor', 'Notlar, kartlar ve günlük aramaya ekleniyor.'],
  error: ['Arama dizini okunamadı', '.cairn/index dosyası açılamadı. Yeniden dene; sorun sürerse cairn index komutuyla dizini yeniden kur.'],
};
const longBody = (record) => `${record.body} ${data.longText.title}. ${data.longText.english}.`;

function records() {
  const list = searchRecords(data);
  if (state !== 'long') return list;
  return list.map((record, index) => ({ ...record, title: `${record.title} — ${index % 2 ? data.longText.english : data.longText.title}`, body: longBody(record) }));
}
function projects() {
  return state === 'long' ? data.projects.map((project) => ({ ...project, name: data.longText.projectName })) : data.projects;
}
function buildFilters(counts) {
  const bar = $('#search-filters');
  bar.replaceChildren(...searchFilters.map(([id, label]) => {
    const pill = button('', () => {
      kind = id;
      update();
      ui.announce(`${label} süzgeci uygulandı.`);
    }, 'button filter-chip');
    pill.setAttribute('aria-pressed', String(id === kind));
    pill.append(el('span', '', label), el('span', 'filter-count counter', String(counts[id] ?? 0)));
    pill.setAttribute('aria-label', `${label}, ${counts[id] ?? 0} sonuç`);
    return pill;
  }));
}
function syncUrl(value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set('q', value);
  else url.searchParams.delete('q');
  if (kind !== 'all') url.searchParams.set('tur', kind);
  else url.searchParams.delete('tur');
  history.replaceState(null, '', url);
}
function renderIdle() {
  $('#search-recent').replaceChildren(...recent.map((term) => {
    const item = el('li');
    item.append(button(term, () => { $('#search-input').value = term; update(); $('#search-input').focus(); }, 'button filter-chip recent-chip'));
    return item;
  }));
}
function update() {
  const value = $('#search-input').value.trim();
  const result = search.render(kind);
  buildFilters(result.counts);
  const idle = !value;
  $('#search-idle').hidden = !idle;
  $('#search-results').hidden = idle || !result.shown;
  $('#search-none').hidden = idle || result.shown > 0;
  $('#search-count').textContent = idle ? '' : result.shown ? `“${value}” için ${result.total} sonuç` : `“${value}” için sonuç yok.`;
  if (!idle && !result.shown) {
    const other = searchFilters.find(([id]) => id !== 'all' && id !== kind && result.counts[id] > 0);
    $('#none-text').textContent = kind !== 'all' && result.counts.all > 0
      ? `Bu türde eşleşme yok ama ${result.counts.all} sonuç başka türlerde.`
      : 'Yazımı kontrol et, daha kısa bir sözcük dene ya da süzgeci kaldır.';
    const actions = [];
    if (kind !== 'all') actions.push(button('Tüm türlerde ara', () => { kind = 'all'; update(); $('#search-input').focus(); }, 'button'));
    if (other && kind === 'all') actions.push(button(`${other[1]} içinde gör`, () => { kind = other[0]; update(); }, 'button'));
    actions.push(button('Aramayı temizle', () => { $('#search-input').value = ''; update(); $('#search-input').focus(); }, 'button button--quiet'));
    $('#none-actions').replaceChildren(...actions);
  }
  if (value !== lastQuery && result.shown && !lessMotion()) {
    // A new query fades the list in; typing within the same results does not move anything.
    $('#search-results').animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: tokenTime('--motion-duration-quick'), easing: getComputedStyle(document.documentElement).getPropertyValue('--motion-ease-out').trim() });
  }
  lastQuery = value;
  syncUrl(value);
}
function setState(value) {
  state = value;
  if (value === 'empty') { data.cards = []; data.notes = []; data.journal = []; }
  $('#prototype-state').value = value;
  renderState(value, () => setState('full'), (event) => ui.create('note', event?.detail === 0), copy);
  if (!['empty', 'loading', 'error'].includes(value)) update();
}
async function start() {
  try {
    data = await loadData('../_shared/workspace.json');
    fixtures = structuredClone(data);
    ui = setupUI(data, () => { if (state === 'empty') setState('full'); else update(); }, (instant) => ui.create('card', instant));
    const input = $('#search-input');
    search = createSearch({ input, records, projects });
    $('#search-results').append(search.list);
    const params = new URLSearchParams(location.search);
    input.value = params.get('q') || '';
    if (searchFilters.some(([id]) => id === params.get('tur'))) kind = params.get('tur');
    input.addEventListener('input', update);
    $('#search-form').addEventListener('submit', (event) => event.preventDefault());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; update(); }
    });
    // On this page / and ⌘K focus the big field instead of opening the dialog.
    document.addEventListener('keydown', (event) => {
      const shortcut = ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') || (event.key === '/' && !event.target.closest('input, textarea, select, [contenteditable="true"]'));
      if (!shortcut || $('#editor').open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      input.focus();
      input.select();
    }, true);
    $('#search-open').addEventListener('click', (event) => { event.stopImmediatePropagation(); input.focus(); input.select(); }, true);
    $('#prototype-state').addEventListener('change', (event) => { Object.assign(data, structuredClone(fixtures)); setState(event.target.value); });
    renderIdle();
    setState('full');
    input.focus({ preventScroll: true });
  } catch {
    renderState('error', start, null, copy);
  }
}
start();
