// The page remains the no-script fallback; only its shared panel is imported into this native dialog.
const dialog = document.querySelector('[data-settings-dialog]');
const opener = document.querySelector('[data-settings-open]');

if (dialog && opener && location.pathname.replace(/\/$/u, '') !== '/settings') {
  const body = dialog.querySelector('[data-settings-body]');
  const content = dialog.querySelector('[data-settings-content]');
  const skeleton = dialog.querySelector('[data-settings-skeleton]');
  const error = dialog.querySelector('[data-settings-error]');
  let sequence = 0;
  let writing = false;
  let changed = false;

  const loading = (pending) => {
    skeleton.hidden = !pending;
    body.setAttribute('aria-busy', String(pending));
  };
  const failed = () => {
    content.replaceChildren();
    loading(false);
    error.hidden = false;
    if (dialog.open) error.querySelector('a').focus();
  };
  const load = async (url, options = {}, focusName = null) => {
    const id = ++sequence;
    try {
      // no-referrer would send Origin: null on POST, which the write guard correctly rejects.
      const response = await fetch(url, { credentials: 'same-origin', referrerPolicy: 'same-origin', ...options });
      const returned = new URL(response.url);
      if (options.method === 'POST' && response.redirected && returned.pathname === '/settings'
        && returned.searchParams.has('saved')) {
        changed = true;
        if (!dialog.open) return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const panel = page.querySelector('[data-settings-panel]');
      if (!panel) throw new Error('Settings panel missing');
      if (id !== sequence || !dialog.open) return;
      const imported = document.importNode(panel, true);
      for (const form of imported.querySelectorAll('form')) {
        const name = form.querySelector('[name="name"]')?.value;
        const previous = [...content.querySelectorAll('form')].find((item) =>
          item.querySelector('[name="name"]')?.value === name);
        const before = previous?.querySelector('[role="switch"]')?.getAttribute('aria-checked');
        const button = form.querySelector('[role="switch"]');
        if (button && before && before !== button.getAttribute('aria-checked')) button.dataset.settingsFrom = before;
      }
      content.replaceChildren(imported);
      loading(false);
      if (focusName) {
        const form = [...content.querySelectorAll('form')].find((item) =>
          (item.querySelector('[name="name"]')?.value ?? item.getAttribute('action')) === focusName);
        form?.querySelector('button[type="submit"]')?.focus();
      }
    } catch {
      if (id === sequence && dialog.open) failed();
    }
  };

  opener.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (dialog.open) return;
    error.hidden = true;
    // A POST already in flight keeps its content and lock if the window is reopened.
    if (!writing) {
      content.replaceChildren();
      loading(true);
    }
    dialog.showModal();
    if (!writing) load('/settings');
  });
  dialog.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !content.contains(form)) return;
    event.preventDefault();
    if (writing) return;
    const data = new URLSearchParams(new FormData(form));
    const focusName = form.querySelector('[name="name"]')?.value ?? form.getAttribute('action');
    writing = true;
    error.hidden = true;
    body.setAttribute('aria-busy', 'true');
    for (const button of content.querySelectorAll('button[type="submit"]')) button.disabled = true;
    try {
      // Send once: on any failure the owner gets the page link, never a second native form submission.
      await load(form.action, { method: 'POST', body: data }, focusName);
    } finally {
      writing = false;
      body.setAttribute('aria-busy', 'false');
      // A close during any write waits for its result before refreshing the shell.
      if (changed && !dialog.open) location.reload();
    }
  });
  dialog.querySelector('[data-settings-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (!writing) sequence++;
    opener.focus();
    if (changed && !writing) location.reload();
  });
}
