(() => {
  let saved;
  try { saved = localStorage.getItem('cairn-mode'); } catch { /* Storage may be unavailable. */ }
  document.documentElement.dataset.mode = saved === 'light' || saved === 'dark' ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
