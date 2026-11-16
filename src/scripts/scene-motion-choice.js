// Settings: the reader's choice for the Cam scene's background motion (system, on or off), kept per browser.
// theme-boot.js applies the stored choice before first paint; this keeps it in step while the page is open.
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function stored() {
  try {
    const value = localStorage.getItem('cairn-scene-motion');
    return value === 'on' || value === 'off' ? value : 'system';
  } catch { return 'system'; }
}

function apply() {
  const choice = stored();
  root.dataset.sceneMotion = choice === 'system' ? (reduced.matches ? 'off' : 'on') : choice;
  for (const note of document.querySelectorAll('[data-scene-motion-system-note]')) {
    note.hidden = !(choice === 'system' && reduced.matches);
  }
}

for (const input of document.querySelectorAll('input[data-scene-motion-value]')) {
  input.checked = input.value === stored();
  input.addEventListener('change', () => {
    if (!input.checked) return;
    try {
      if (input.value === 'system') localStorage.removeItem('cairn-scene-motion');
      else localStorage.setItem('cairn-scene-motion', input.value);
    } catch { /* The current page still follows the choice. */ }
    for (const other of document.querySelectorAll(`input[data-scene-motion-value][value="${input.value}"]`)) {
      other.checked = true;
    }
    apply();
  });
}
reduced.addEventListener?.('change', apply);
apply();
