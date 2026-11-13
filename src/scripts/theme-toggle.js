import { cssTimeMs } from './css-time.js';

const root = document.documentElement;
const button = document.querySelector('[data-theme-toggle]');
const system = matchMedia('(prefers-color-scheme: dark)');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let chosen = false;
try { chosen = ['light', 'dark'].includes(localStorage.getItem('cairn-mode')); } catch { /* Keep working without storage. */ }

function updateLabel() {
  button.setAttribute('aria-label', root.dataset.mode === 'dark' ? button.dataset.lightLabel : button.dataset.darkLabel);
}
updateLabel();
system.addEventListener('change', () => {
  if (!chosen) {
    root.dataset.mode = system.matches ? 'dark' : 'light';
    updateLabel();
  }
});

let transition;
button.addEventListener('click', async () => {
  transition?.skipTransition();
  const mode = root.dataset.mode === 'dark' ? 'light' : 'dark';
  const apply = () => {
    root.dataset.mode = mode;
    chosen = true;
    try { localStorage.setItem('cairn-mode', mode); } catch { /* The current page still changes mode. */ }
    updateLabel();
  };
  if (!document.startViewTransition || reduced.matches) { apply(); return; }
  const { x, y, width, height } = button.getBoundingClientRect();
  const cx = x + width / 2, cy = y + height / 2;
  const radius = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy));
  const active = transition = document.startViewTransition(apply);
  try {
    await active.ready;
    if (reduced.matches || transition !== active) return;
    const tokens = getComputedStyle(root);
    root.animate({ clipPath: [`circle(0px at ${cx}px ${cy}px)`, `circle(${radius}px at ${cx}px ${cy}px)`] }, {
      duration: cssTimeMs(tokens.getPropertyValue('--motion-duration-theme-reveal')),
      easing: tokens.getPropertyValue('--motion-ease-out-quart').trim(),
      pseudoElement: '::view-transition-new(root)',
    });
  } catch { /* A skipped transition has already applied the palette. */ }
});
