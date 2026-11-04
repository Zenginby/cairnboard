import { log } from '../_shared/log.js';

const main = document.getElementById('main');
const mode = document.body.dataset.mode;

function buildBoard() {
  const el = document.createElement('div');
  el.className = 'board';
  for (let i = 1; i <= 300; i++) {
    const c = document.createElement('div');
    c.className = 'card';
    c.innerHTML = `<b>Kart ${i}</b><span class="muted">acme / ornek-proje</span>`;
    el.append(c);
  }
  return el;
}

function buildNote() {
  const el = document.createElement('article');
  el.className = 'note';
  // 100 x (heading + 8rem paragraph) is roughly 20,000 px; the page shows the measured height.
  for (let i = 1; i <= 100; i++) {
    const h = document.createElement('h2');
    h.textContent = `Section ${i}`;
    const p = document.createElement('p');
    p.textContent = 'Fictional note text for acme ornek-proje. '.repeat(40);
    el.append(h, p);
  }
  return el;
}

const builders = { board: buildBoard, note: buildNote };

function show(view) {
  main.replaceChildren(builders[view]());
  main.dataset.view = view;
  const cur = document.getElementById('current');
  if (cur) cur.textContent = `view: ${view}, scrollHeight: ${document.documentElement.scrollHeight}px`;
}

if (mode === 'board' || mode === 'note') {
  show(mode);
  log(`${mode} height=${document.documentElement.scrollHeight}`);
} else {
  const named = document.getElementById('named');
  const useVt = document.getElementById('vt');
  const supported = typeof document.startViewTransition === 'function';
  document.getElementById('support').textContent = supported
    ? 'View Transitions: supported'
    : 'View Transitions: NOT supported in this browser (switch is instant)';
  if (!supported) { log('document.startViewTransition is not available'); useVt.checked = false; useVt.disabled = true; }
  show('board');

  named.addEventListener('change', () => {
    main.classList.toggle('named', named.checked);
    log(`main view-transition-name: ${named.checked ? 'main' : 'none'}`);
  });

  document.getElementById('toggle').addEventListener('click', async () => {
    const next = main.dataset.view === 'board' ? 'note' : 'board';
    const t0 = performance.now();
    if (!supported || !useVt.checked) { show(next); log(`switched to ${next} without transition`); return; }
    const vt = document.startViewTransition(() => show(next));
    log(`startViewTransition → ${next} (named=${named.checked})`);
    vt.ready.then(() => log(`ready after ${(performance.now() - t0).toFixed(0)} ms`), (e) => log(`ready rejected: ${e?.name}: ${e?.message}`));
    vt.updateCallbackDone.then(() => log(`update done after ${(performance.now() - t0).toFixed(0)} ms`));
    try { await vt.finished; log(`finished after ${(performance.now() - t0).toFixed(0)} ms`); }
    catch (e) { log(`finished rejected: ${e?.name}`); }
  });
}
