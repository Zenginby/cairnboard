(() => {
  const root = document.documentElement;
  let saved, glass;
  try {
    saved = localStorage.getItem('cairn-mode');
    glass = localStorage.getItem('cairn-glass');
  } catch { /* Storage may be unavailable. */ }
  root.dataset.mode = saved === 'light' || saved === 'dark' ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  // Glass themes fall back to opaque surfaces when the reader asks for less transparency or more contrast, unless
  // they chose glass on or off in Settings (glass-choice.js). Read here rather than in a media query so engines
  // that do not know the feature still get glass.
  const plain = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)');
  root.dataset.glass = glass === 'on' || glass === 'off' ? glass : plain.matches ? 'off' : 'on';
})();
