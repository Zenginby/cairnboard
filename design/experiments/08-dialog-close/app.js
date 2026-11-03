import { log } from '../_shared/log.js';

const dlg = document.getElementById('dlg');
let phase = 'open';
const seen = { open: { start: new Set(), end: new Set() }, close: { start: new Set(), end: new Set() } };

function render() {
  for (const p of ['open', 'close']) {
    const cells = document.getElementById(`row-${p}`).cells;
    const s = seen[p];
    cells[1].textContent = s.start.size ? [...s.start].join(', ') : 'none';
    cells[2].textContent = s.end.size ? [...s.end].join(', ') : 'none';
    const disc = ['display', 'overlay'].filter((x) => s.start.has(x) || s.end.has(x));
    cells[3].textContent = disc.length ? `yes (${disc.join(', ')})` : 'no';
  }
}

function track(kind) {
  return (e) => {
    if (e.target !== dlg) return;
    log(`${e.type} ${e.propertyName} elapsed=${e.elapsedTime.toFixed(3)}s phase=${phase}`);
    if (kind === 'start' || kind === 'end') { seen[phase][kind].add(e.propertyName); render(); }
  };
}
dlg.addEventListener('transitionrun', track('run'));
dlg.addEventListener('transitionstart', track('start'));
dlg.addEventListener('transitionend', track('end'));
dlg.addEventListener('transitioncancel', track('cancel'));

function resetPhase(p) {
  phase = p;
  seen[p].start.clear();
  seen[p].end.clear();
  render();
}

document.getElementById('open').addEventListener('click', () => {
  resetPhase('open');
  dlg.showModal();
  log('showModal()');
});
// Esc and form submit both go through "close"; catch the earlier events to label the phase.
dlg.addEventListener('cancel', () => { resetPhase('close'); log('cancel event (Esc)'); });
dlg.addEventListener('close', () => log(`close event, open=${dlg.open}`));
document.getElementById('ok').addEventListener('click', () => resetPhase('close'));
dlg.addEventListener('click', (e) => {
  if (e.target === dlg) { resetPhase('close'); dlg.close(); log('backdrop click → close()'); }
});
render();
