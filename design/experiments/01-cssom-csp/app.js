import { log } from '../_shared/log.js';

const box = document.getElementById('box');
const tbody = document.getElementById('results');
const buttons = document.getElementById('buttons');
let violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));

const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const tx = () => {
  const m = new DOMMatrix(getComputedStyle(box).transform === 'none' ? undefined : getComputedStyle(box).transform);
  return m.m41;
};
const transl = () => {
  const t = getComputedStyle(box).translate;
  return t === 'none' ? 0 : parseFloat(t) || 0;
};

function reset() {
  box.removeAttribute('style');
  box.classList.remove('var-target');
  box.getAnimations().forEach((a) => a.cancel());
  document.adoptedStyleSheets = [];
  const sheet = document.styleSheets[0];
  for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
    if (sheet.cssRules[i].selectorText === '#box') sheet.deleteRule(i);
  }
}

const methods = [
  { id: 'setProperty', name: "el.style.setProperty('--x','40px') + rule translate: var(--x)", run() {
    box.classList.add('var-target');
    box.style.setProperty('--x', '40px');
  }, measure: () => transl() },
  { id: 'transform', name: "el.style.transform = 'translateX(40px)'", run() { box.style.transform = 'translateX(40px)'; }, measure: tx },
  { id: 'cssText', name: "el.style.cssText = 'transform: translateX(40px)'", run() { box.style.cssText = 'transform: translateX(40px)'; }, measure: tx },
  { id: 'setAttribute', name: "el.setAttribute('style','transform: translateX(40px)')", run() { box.setAttribute('style', 'transform: translateX(40px)'); }, measure: tx },
  { id: 'insertRule', name: 'document.styleSheets[0].insertRule(...)', run() {
    document.styleSheets[0].insertRule('#box { transform: translateX(40px); }', document.styleSheets[0].cssRules.length);
  }, measure: tx },
  { id: 'adopted', name: 'new CSSStyleSheet() + replaceSync + adoptedStyleSheets', run() {
    const s = new CSSStyleSheet();
    s.replaceSync('#box { transform: translateX(40px); }');
    document.adoptedStyleSheets = [s];
  }, measure: tx },
  { id: 'animate', name: "el.animate([...], {duration:200, fill:'forwards'})", async run() {
    const a = box.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(40px)' }], { duration: 200, fill: 'forwards' });
    await a.finished.catch(() => {});
  }, measure: tx },
];

const rows = new Map();
for (const m of methods) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td></td><td>—</td><td>—</td>';
  tr.cells[0].textContent = m.name;
  tbody.append(tr);
  rows.set(m.id, tr);
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = m.id;
  b.addEventListener('click', () => test(m));
  buttons.append(b);
}

async function test(m) {
  reset();
  await raf();
  violations = [];
  let error = '';
  try { await m.run(); } catch (e) { error = `${e.name}: ${e.message}`; log(`${m.id} threw ${error}`); }
  await raf();
  await new Promise((r) => setTimeout(r, 50)); // violation events are queued tasks
  const v = m.measure();
  const applied = Math.abs(v - 40) < 0.5;
  const tr = rows.get(m.id);
  tr.cells[1].textContent = applied ? `yes (${v}px)` : `no (${v}px)${error ? ' – threw' : ''}`;
  tr.cells[1].className = applied ? 'yes' : 'no';
  tr.cells[2].textContent = violations.length ? `yes (${[...new Set(violations)].join(', ')})` : 'no';
  tr.cells[2].className = violations.length ? 'no' : 'yes';
  log(`${m.id}: applied=${applied} violations=${violations.length}`);
}

document.getElementById('all').addEventListener('click', async () => {
  for (const m of methods) await test(m);
  reset();
});
document.getElementById('reset').addEventListener('click', reset);
