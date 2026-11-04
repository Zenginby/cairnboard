const root = document.documentElement;
// A theme is a family (data-theme) shown in a mode (data-mode: light, dark, or absent to follow the system).
export const families = { bento: 'Bento', paper: 'Kâğıt', graphite: 'Grafit' };
const modes = ['system', 'light', 'dark'];
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Preferences still work without storage. */ }
}

export function isDark() {
  return root.dataset.mode ? root.dataset.mode === 'dark' : systemDark.matches;
}
function labelToggles() {
  const dark = isDark();
  document.querySelectorAll('[data-theme-toggle]').forEach((toggle) => {
    toggle.setAttribute('aria-label', dark ? 'Açık görünüme geç' : 'Koyu görünüme geç');
    toggle.classList.toggle('is-dark', dark);
  });
}

// The new palette grows as a circle from the control that changed it (DESIGN.md, Motion). Instant without view
// transitions, with reduced motion or with "Hareket: az". Pressing again mid-reveal skips to the newest one.
let lastReveal;
function reveal(origin, apply) {
  if (!origin || !document.startViewTransition || reducedMotion.matches || root.dataset.motion === 'less') {
    apply();
    return;
  }
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  root.style.setProperty('--theme-reveal-x', `${x}px`);
  root.style.setProperty('--theme-reveal-y', `${y}px`);
  root.style.setProperty('--theme-reveal-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
  root.dataset.themeReveal = '';
  const transition = document.startViewTransition(apply);
  lastReveal = transition;
  // A newer reveal or a hidden tab skips this one; that is expected, not an error.
  transition.ready.catch(() => {});
  transition.finished.finally(() => {
    if (lastReveal === transition) delete root.dataset.themeReveal;
  });
}

function applyTheme(family) {
  root.dataset.theme = family;
  document.querySelectorAll('[data-theme-menu]').forEach((menu) => { menu.value = family; });
  savePreference('prototype-theme', family);
  root.dispatchEvent(new CustomEvent('themechange'));
}
function applyMode(mode) {
  if (mode === 'system') root.removeAttribute('data-mode');
  else root.dataset.mode = mode;
  document.querySelectorAll('[data-mode-menu]').forEach((menu) => { menu.value = mode; });
  savePreference('prototype-mode', mode);
  labelToggles();
  root.dispatchEvent(new CustomEvent('themechange'));
}
export function setTheme(family, origin) {
  if (!Object.hasOwn(families, family)) family = 'bento';
  reveal(origin, () => applyTheme(family));
}
export function setMode(mode, origin) {
  if (!modes.includes(mode)) mode = 'system';
  reveal(origin, () => applyMode(mode));
}
// The sun/moon button switches between light and dark from whatever is showing now.
export function toggleMode(origin) {
  setMode(isDark() ? 'light' : 'dark', origin);
}
export function setLessMotion(less) {
  if (less) root.dataset.motion = 'less';
  else root.removeAttribute('data-motion');
  document.querySelectorAll('[data-motion-toggle]').forEach((toggle) => { toggle.checked = less; });
  savePreference('prototype-motion', less ? 'less' : 'system');
  root.dispatchEvent(new CustomEvent('motionchange'));
}

applyTheme(Object.hasOwn(families, readPreference('prototype-theme')) ? readPreference('prototype-theme') : 'bento');
applyMode(modes.includes(readPreference('prototype-mode')) ? readPreference('prototype-mode') : 'system');
setLessMotion(readPreference('prototype-motion') === 'less');
systemDark.addEventListener('change', labelToggles);
// Delegated, so controls added later (menus, re-rendered headers) work too.
document.addEventListener('change', (event) => {
  const control = event.target;
  if (control.matches?.('[data-theme-menu]')) setTheme(control.value, control);
  else if (control.matches?.('[data-mode-menu]')) setMode(control.value, control);
  else if (control.matches?.('[data-motion-toggle]')) setLessMotion(control.checked);
});
document.addEventListener('click', (event) => {
  const toggle = event.target.closest?.('[data-theme-toggle]');
  if (toggle) toggleMode(toggle);
});
