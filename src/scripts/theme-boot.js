(() => {
  const root = document.documentElement;
  let saved;
  try { saved = localStorage.getItem('cairn-mode'); } catch { /* Storage may be unavailable. */ }
  root.dataset.mode = saved === 'light' || saved === 'dark' ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  // Glass themes fall back to opaque surfaces when the reader asks for less transparency or more contrast.
  // Read here rather than in a media query so engines that do not know the feature still get glass.
  const plain = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)');
  const apply = () => { root.dataset.glass = plain.matches ? 'off' : 'on'; };
  apply();
  plain.addEventListener?.('change', apply);
})();
