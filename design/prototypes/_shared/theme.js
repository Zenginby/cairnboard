const root = document.documentElement;
const themes = ['system', 'bento', 'bento-dark', 'paper', 'graphite'];

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Preferences still work without storage. */ }
}
export function setTheme(theme) {
  if (!themes.includes(theme)) theme = 'system';
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;
  document.querySelectorAll('[data-theme-menu]').forEach((menu) => { menu.value = theme; });
  savePreference('prototype-theme', theme);
  root.dispatchEvent(new CustomEvent('themechange'));
}
export function setLessMotion(less) {
  if (less) root.dataset.motion = 'less';
  else root.removeAttribute('data-motion');
  document.querySelectorAll('[data-motion-toggle]').forEach((toggle) => { toggle.checked = less; });
  savePreference('prototype-motion', less ? 'less' : 'system');
  root.dispatchEvent(new CustomEvent('motionchange'));
}
setTheme(readPreference('prototype-theme') || 'system');
setLessMotion(readPreference('prototype-motion') === 'less');
document.querySelectorAll('[data-theme-menu]').forEach((menu) => {
  menu.addEventListener('change', () => setTheme(menu.value));
});
document.querySelectorAll('[data-motion-toggle]').forEach((toggle) => {
  toggle.addEventListener('change', () => setLessMotion(toggle.checked));
});
