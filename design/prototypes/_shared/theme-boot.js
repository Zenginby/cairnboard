// Runs as a classic, render-blocking script before the first paint: it applies the saved theme, mode, motion and
// pinned-rail state, so a page never paints with the default palette or layout and then jumps. theme.js and
// pinned-rail.js take over from these attributes once the modules run.
(() => {
  const root = document.documentElement;
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const theme = read('prototype-theme');
  root.dataset.theme = ['bento', 'paper', 'graphite'].includes(theme) ? theme : 'bento';
  const mode = read('prototype-mode');
  if (mode === 'light' || mode === 'dark') root.dataset.mode = mode;
  if (read('prototype-motion') === 'less') root.dataset.motion = 'less';
  // Only pages that load the rail (their boot tag carries data-rail) reserve room for it.
  if (document.currentScript?.hasAttribute('data-rail')) root.dataset.pinnedRail = read('prototype-pinned-rail') === 'closed' ? 'closed' : 'open';
})();
