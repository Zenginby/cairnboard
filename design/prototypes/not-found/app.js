import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, loadData, setupUI, renderState } from '../_shared/app-ui.js';
import { hrefFor, searchKinds } from '../_shared/search-results.js';

// 404: the card always shows; the prototype states change only the suggestions below it.
let data;
let ui;
const easing = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function suggestions(state) {
  const box = $('#suggest');
  const body = $('#suggest-body');
  box.hidden = state === 'empty';
  body.setAttribute('aria-busy', String(state === 'loading'));
  if (state === 'loading') {
    const skeletons = el('div', 'suggest-skeletons');
    skeletons.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 3; index++) skeletons.append(el('div', 'skeleton'));
    body.replaceChildren(skeletons, el('p', 'muted type-label', 'Son açılan sayfalar getiriliyor.'));
    return;
  }
  if (state === 'error' || !data) {
    body.replaceChildren(el('p', 'muted', 'Öneriler yüklenemedi. Ana sayfadan ya da aramadan devam edebilirsin.'));
    return;
  }
  const list = el('ul', 'suggest-list');
  data.notes.filter((note) => note.title).slice(0, 4).forEach((note, index) => {
    const item = el('li');
    const link = el('a', 'suggest-link');
    link.href = hrefFor({ id: note.id, kind: note.kind || 'note' });
    const title = state === 'long' ? `${note.title} — ${index % 2 ? data.longText.english : data.longText.title}` : note.title;
    link.append(el('span', '', title), el('span', 'suggest-kind', searchKinds[note.kind || 'note']));
    item.append(link);
    list.append(item);
  });
  body.replaceChildren(list);
}
function setState(value) {
  $('#prototype-state').value = value;
  renderState('full', null, null);
  $('#status-text').textContent = value === 'long'
    ? 'Aradığın sayfa taşınmış, adı değişmiş, Çöp’e gitmiş ya da hiç olmamış olabilir. Çöp’teki öğeler kalıcı olarak silinmez; oradan geri yükleyebilirsin. Ana sayfadan ya da aramadan devam edebilirsin.'
    : 'Taşınmış, adı değişmiş ya da hiç olmamış olabilir. Ana sayfadan devam edebilirsin.';
  suggestions(value);
}
function entrance() {
  const less = lessMotion();
  document.querySelectorAll('.status-card, .status-suggest').forEach((node, index) => node.animate(less ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(var(--motion-distance-base))' }, { opacity: 1, transform: 'none' }], { duration: tokenTime(less ? '--motion-duration-quick' : '--motion-duration-fast'), delay: less ? 0 : index * tokenTime('--motion-duration-stagger'), easing: easing('--motion-ease-spring'), fill: 'backwards' }));
}
async function start() {
  try {
    data = await loadData('../_shared/workspace.json');
  } catch {
    data = null;
  }
  ui = setupUI(data || { cards: [], notes: [], journal: [], projects: [], people: [], columns: [] }, () => {}, (instant) => ui.create('card', instant));
  $('#status-search').addEventListener('click', () => $('#search-open').click());
  $('#prototype-state').addEventListener('change', (event) => setState(event.target.value));
  setState(data ? 'full' : 'error');
  entrance();
}
start();
