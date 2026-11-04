import { log } from '../_shared/log.js';

const root = document.documentElement;
const main = document.getElementById('main');
const pill = document.querySelector('.pill');
const select = document.getElementById('variant');
const STORAGE_NAME = 'cairn-exp03-variant';
const hasVT = typeof document.startViewTransition === 'function';

let variant = 'a';
try { variant = localStorage.getItem(STORAGE_NAME) || 'a'; } catch { /* storage blocked */ }
if (!/^[abcd]$/.test(variant)) variant = 'a';
select.value = variant;
applyVariant(variant);
if (!hasVT) log('startViewTransition not supported: variants a, b, d fall back to instant swap');

function applyVariant(v) {
  variant = v;
  root.classList.remove('v-a', 'v-b', 'v-c', 'v-d');
  root.classList.add(`v-${v}`);
}
select.addEventListener('change', () => {
  applyVariant(select.value);
  try { localStorage.setItem(STORAGE_NAME, variant); } catch { /* ignore */ }
  log(`variant = ${variant}`);
});

const order = (path) => (path.endsWith('second.html') ? 1 : 0);
let current = order(location.pathname);

function applyDoc(doc, url) {
  const next = doc.getElementById('main');
  main.replaceChildren(...[...next.childNodes].map((n) => document.importNode(n, true)));
  document.title = doc.title;
  const idx = order(url.pathname);
  pill.classList.toggle('p1', idx === 1);
  pill.classList.toggle('p0', idx === 0);
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (Number(a.dataset.order) === idx) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  current = idx;
}

let seq = 0;
async function go(href, { push }) {
  const url = new URL(href, location.href);
  const my = ++seq;
  let doc;
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  } catch (e) {
    log(`fetch failed (${e.message}); hard navigation`);
    location.href = url.href;
    return;
  }
  if (my !== seq) return;
  root.dataset.dir = order(url.pathname) >= current ? 'fwd' : 'back';
  if (push) history.pushState({}, '', url);
  const swap = () => applyDoc(doc, url);
  const t0 = performance.now();
  if (variant === 'c' || !hasVT) {
    swap();
    if (variant === 'c') {
      main.classList.remove('enter');
      void main.offsetWidth;
      main.classList.add('enter');
      main.addEventListener('animationend', () => main.classList.remove('enter'), { once: true });
    }
    log(`swap ${variant} dir=${root.dataset.dir}`);
    return;
  }
  const vt = document.startViewTransition(swap);
  try {
    await vt.finished;
    log(`transition ${variant} dir=${root.dataset.dir} finished in ${(performance.now() - t0).toFixed(0)} ms`);
  } catch (e) { log(`transition ${variant} aborted: ${e?.name}`); }
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('.tabs a');
  if (!a) return;
  e.preventDefault();
  if (order(new URL(a.href).pathname) === current) return;
  go(a.href, { push: true });
});
addEventListener('popstate', () => go(location.href, { push: false }));
