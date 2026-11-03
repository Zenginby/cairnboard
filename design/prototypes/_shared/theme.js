const root = document.documentElement;
// A theme is a family (data-theme) shown in a mode (data-mode: light, dark, or absent to follow the system).
export const families = { bento: 'Bento', paper: 'Kâğıt', graphite: 'Grafit' };
const modes = ['system', 'light', 'dark'];

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Preferences still work without storage. */ }
}
export function setTheme(family) {
  if (!Object.hasOwn(families, family)) family = 'bento';
  root.dataset.theme = family;
  document.querySelectorAll('[data-theme-menu]').forEach((menu) => { menu.value = family; });
  savePreference('prototype-theme', family);
  root.dispatchEvent(new CustomEvent('themechange'));
}
export function setMode(mode) {
  if (!modes.includes(mode)) mode = 'system';
  if (mode === 'system') root.removeAttribute('data-mode');
  else root.dataset.mode = mode;
  document.querySelectorAll('[data-mode-menu]').forEach((menu) => { menu.value = mode; });
  savePreference('prototype-mode', mode);
  root.dispatchEvent(new CustomEvent('themechange'));
}
export function setLessMotion(less) {
  if (less) root.dataset.motion = 'less';
  else root.removeAttribute('data-motion');
  document.querySelectorAll('[data-motion-toggle]').forEach((toggle) => { toggle.checked = less; });
  savePreference('prototype-motion', less ? 'less' : 'system');
  root.dispatchEvent(new CustomEvent('motionchange'));
}
setTheme(readPreference('prototype-theme') || 'bento');
setMode(readPreference('prototype-mode') || 'system');
setLessMotion(readPreference('prototype-motion') === 'less');
document.querySelectorAll('[data-theme-menu]').forEach((menu) => {
  menu.addEventListener('change', () => setTheme(menu.value));
});
document.querySelectorAll('[data-mode-menu]').forEach((menu) => {
  menu.addEventListener('change', () => setMode(menu.value));
});
document.querySelectorAll('[data-motion-toggle]').forEach((toggle) => {
  toggle.addEventListener('change', () => setLessMotion(toggle.checked));
});
