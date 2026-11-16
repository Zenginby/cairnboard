(() => {
  const root = document.documentElement;
  let saved, glass, rail, sceneMotion;
  try {
    saved = localStorage.getItem('cairn-mode');
    glass = localStorage.getItem('cairn-glass');
    rail = localStorage.getItem('cairn-pinned-rail');
    sceneMotion = localStorage.getItem('cairn-scene-motion');
  } catch { /* Storage may be unavailable. */ }
  root.dataset.mode = saved === 'light' || saved === 'dark' ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  // Glass themes fall back to opaque surfaces when the reader asks for less transparency or more contrast, unless
  // they chose glass on or off in Settings (glass-choice.js). Read here rather than in a media query so engines
  // that do not know the feature still get glass.
  const plain = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)');
  root.dataset.glass = glass === 'on' || glass === 'off' ? glass : plain.matches ? 'off' : 'on';
  // The Cam scene drifts unless the reader asks their system for less motion, or chose on or off in Settings
  // (scene-motion-choice.js). Without this script the scene stands still.
  root.dataset.sceneMotion = sceneMotion === 'on' || sceneMotion === 'off' ? sceneMotion
    : matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on';
  root.dataset.pinnedRail = rail === 'closed' ? 'closed' : 'open';
})();
