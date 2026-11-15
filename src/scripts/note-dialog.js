// Global quick-note dialog (`N` key). The `/notes/new` page stays the script-free fallback.
import { typing } from './typing.js';

const dialog = document.querySelector('[data-note-dialog]');

if (dialog) {
  const content = dialog.querySelector('[data-note-dialog-content]');
  const status = dialog.querySelector('[data-note-dialog-status]');
  const closeButton = dialog.querySelector('[data-note-dialog-close]');
  let opener = null;
  let sequence = 0;
  let writing = false;

  const messageOf = (html) => {
    const page = new DOMParser().parseFromString(html, 'text/html');
    const main = page.querySelector('main');
    const parts = [...(main?.querySelectorAll('h1, h2, p') ?? [])].map((node) => node.textContent.trim())
      .filter(Boolean).slice(0, 2);
    return parts.join(' — ');
  };

  const showSaved = (href) => {
    status.replaceChildren();
    status.append(document.createTextNode(`${status.dataset.saved || 'Saved.'} `));
    const link = document.createElement('a');
    link.href = href;
    link.textContent = status.dataset.open || 'Open note';
    status.append(link);
  };

  const close = () => {
    if (!writing && dialog.open) dialog.close();
  };

  async function open() {
    if (document.querySelector('dialog[open]')) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = ++sequence;
    content.replaceChildren();
    status.textContent = status.dataset.loading || '';
    dialog.showModal();
    try {
      const response = await fetch('/notes/new', { credentials: 'same-origin', referrerPolicy: 'same-origin' });
      const html = await response.text();
      if (id !== sequence || !dialog.open) return;
      const page = new DOMParser().parseFromString(html, 'text/html');
      const panel = page.querySelector('[data-note-panel]');
      if (!response.ok || !panel) {
        status.textContent = messageOf(html) || status.dataset.error || '';
        return;
      }
      status.textContent = '';
      content.replaceChildren(document.importNode(panel, true));
      content.querySelector('input[name="title"]')?.focus();
    } catch {
      if (id === sequence && dialog.open) status.textContent = status.dataset.error || '';
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() !== 'n') return;
    if (typing(event.target) || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    open();
  });

  content.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.button !== 0 || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey) return;
    if (!event.target.closest('[data-note-cancel]')) return;
    event.preventDefault();
    close();
  });

  content.addEventListener('submit', async (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    event.preventDefault();
    if (writing) return;
    const submit = form.querySelector('button[type="submit"]');
    writing = true;
    if (submit) submit.disabled = true;
    status.textContent = '';
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        referrerPolicy: 'same-origin',
        body: new URLSearchParams(new FormData(form)),
      });
      const target = response.url ? new URL(response.url, location.origin) : null;
      if (response.ok && response.redirected && target && target.origin === location.origin
        && target.pathname.startsWith('/notes/') && target.pathname !== '/notes/new') {
        form.reset();
        showSaved(target.pathname);
        form.querySelector('input[name="title"]')?.focus();
        return;
      }
      const text = messageOf(await response.text());
      status.textContent = text || status.dataset.saveError || '';
    } catch {
      status.textContent = status.dataset.saveError || '';
    } finally {
      writing = false;
      if (submit) submit.disabled = false;
    }
  });

  closeButton?.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { if (writing) event.preventDefault(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog || writing) return;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) close();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    if (!writing) sequence++;
    content.replaceChildren();
    status.textContent = '';
    const target = opener;
    opener = null;
    if (target?.isConnected) target.focus();
  });
}
