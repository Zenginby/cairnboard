import { log } from '../_shared/log.js';

const row = document.getElementById('search-row');
const q = document.getElementById('q');
const verdict = document.getElementById('verdict');
const strategy = document.getElementById('strategy');
const SHORTCUTS = new Set(['n', 'c', 'm', 'g', '/', '?']);

const editable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const show = (s) => JSON.stringify(s);

function openSearch() {
  const was = row.hidden;
  row.hidden = false;
  q.focus();
  return was;
}

function closeSearch() {
  q.value = '';
  verdict.textContent = '';
  row.hidden = true;
  q.blur();
}

document.getElementById('clear').addEventListener('click', closeSearch);

document.addEventListener('keydown', (e) => {
  log(`keydown key=${show(e.key)} code=${e.code} keyCode=${e.keyCode} isComposing=${e.isComposing} target=${e.target.tagName.toLowerCase()}`);
  if (e.key === 'Escape' && !row.hidden) { closeSearch(); return; }
  if (editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (SHORTCUTS.has(e.key)) { log(`shortcut ${show(e.key)}: search not opened`); return; }
  const printable = e.key.length === 1 || [...e.key].length === 1; // astral characters count as one
  const dead = e.key === 'Dead' || e.keyCode === 229;
  if (!printable && !dead) return;
  const expected = printable ? e.key : null;
  if (strategy.value === 'manual' && printable) {
    e.preventDefault();
    openSearch();
    q.value += e.key;
  } else {
    openSearch();
  }
  // Let the browser finish default handling, then check whether the first character survived.
  setTimeout(() => {
    const got = q.value;
    const text = expected === null
      ? `dead/composing key opened search; value=${show(got)}`
      : got.startsWith(expected) ? `OK: first char ${show(expected)} arrived (value=${show(got)})` : `LOST: expected ${show(expected)}, value=${show(got)}`;
    verdict.textContent = text;
    log(text);
  }, 120);
}, true);

for (const type of ['beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend']) {
  document.addEventListener(type, (e) => {
    log(`${type} data=${show(e.data)} inputType=${e.inputType ?? '-'} isComposing=${e.isComposing ?? '-'} target=${e.target.tagName.toLowerCase()}`);
  }, true);
}
