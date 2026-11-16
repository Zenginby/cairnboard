// "Add link" on the note forms: the chosen page goes into the body as `[[name|title]]` at the cursor.
// The quick-note dialog imports its form later, so the listener is delegated and the dialog calls `showLinks`.

/** Reveals the script-only link pickers under `root`. */
export function showLinks(root = document) {
  for (const picker of root.querySelectorAll('[data-note-link]')) picker.hidden = false;
}

/** A link title may not close the link or start the label early. */
const label = (title) => title.replace(/[[\]|]/gu, ' ').replace(/\s+/gu, ' ').trim();

document.addEventListener('change', (event) => {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  const picker = select.closest('[data-note-link]');
  if (!picker || !select.value) return;
  const form = picker.closest('form');
  const body = form?.querySelector(`#${CSS.escape(picker.dataset.noteLink)}`) ?? form?.querySelector('textarea');
  const option = select.selectedOptions[0];
  select.value = '';
  if (!(body instanceof HTMLTextAreaElement) || !option) return;
  const title = label(option.dataset.title || option.textContent || '');
  const link = title && title !== option.value ? `[[${option.value}|${title}]]` : `[[${option.value}]]`;
  const start = body.selectionStart ?? body.value.length;
  const end = body.selectionEnd ?? start;
  const before = body.value.slice(0, start);
  const space = before && !/\s$/u.test(before) ? ' ' : '';
  body.focus();
  body.setRangeText(`${space}${link}`, start, end, 'end');
  body.dispatchEvent(new Event('input', { bubbles: true }));
});

showLinks();
