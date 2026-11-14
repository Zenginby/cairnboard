// Settings: the reader's glass choice for the Cam theme (system, on or off), kept per browser.
// theme-boot.js applies the stored choice before first paint; this keeps it in step while the page is open.
const root = document.documentElement;
const plain = matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)');

function stored() {
  try {
    const value = localStorage.getItem('cairn-glass');
    return value === 'on' || value === 'off' ? value : 'system';
  } catch { return 'system'; }
}

function apply() {
  const choice = stored();
  root.dataset.glass = choice === 'system' ? (plain.matches ? 'off' : 'on') : choice;
  for (const note of document.querySelectorAll('[data-glass-system-note]')) {
    note.hidden = !(choice === 'system' && plain.matches);
  }
}

for (const box of document.querySelectorAll('[data-glass-choice]')) {
  box.hidden = false;
  for (const input of box.querySelectorAll('input[data-glass-value]')) {
    input.checked = input.value === stored();
    input.addEventListener('change', () => {
      if (!input.checked) return;
      try {
        if (input.value === 'system') localStorage.removeItem('cairn-glass');
        else localStorage.setItem('cairn-glass', input.value);
      } catch { /* The current page still follows the choice. */ }
      for (const other of document.querySelectorAll(`input[data-glass-value][value="${input.value}"]`)) {
        other.checked = true;
      }
      apply();
    });
  }
}
plain.addEventListener?.('change', apply);
apply();
