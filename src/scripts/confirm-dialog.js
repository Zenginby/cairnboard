// A themed yes/no question in the middle of the screen, in place of the browser's own confirm box.
const dialog = document.querySelector('[data-confirm-dialog]');
let settle = null;

/**
 * Resolves true when the owner confirms, false on Cancel, Escape or a click outside.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function ask(message) {
  // Without the dialog (an old page) the browser's box still asks.
  if (!dialog) return Promise.resolve(window.confirm(message));
  if (settle) settle(false);
  dialog.querySelector('[data-confirm-text]').textContent = message;
  dialog.showModal();
  dialog.querySelector('[data-confirm-cancel]')?.focus();
  return new Promise((resolve) => { settle = resolve; });
}

if (dialog) {
  const finish = (answer) => {
    const done = settle;
    settle = null;
    if (dialog.open) dialog.close();
    done?.(answer);
  };
  dialog.querySelector('[data-confirm-ok]')?.addEventListener('click', () => finish(true));
  dialog.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => finish(false));
  dialog.addEventListener('close', () => finish(false));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) finish(false);
  });
}
