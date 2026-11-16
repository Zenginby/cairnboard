// A note link opens the note in a dialog instead of a new page. The note page stays the no-script fallback (and a
// modified click still opens it): the dialog fetches it, imports its `[data-note-view-panel]` and posts its pin and
// delete forms with fetch. Edit leaves for the edit page.
import { toast } from './toast.js';

const dialog = document.querySelector('[data-note-view]');
const NOTE = /^\/notes\/([Nn]-[0-9A-Za-z]{1,24})$/u;

/** The title a note form acts on, read from the page text (titles never sit in attributes). */
export const noteTitleOf = (node) => (node.closest('[data-notes-item]')?.querySelector('.row-title')
  ?? node.closest('[data-note-view-panel]')?.querySelector('.document-heading h1'))?.textContent?.trim() ?? '';

/** Delete needs the confirm step below, so its forms show only once this script runs. */
export const showDelete = (root = document) => {
  for (const form of root.querySelectorAll('[data-note-delete][hidden]')) form.hidden = false;
};
showDelete();
document.addEventListener('live:updated', () => showDelete());

/** Delete asks first everywhere, on the note page as in the dialog and the notes list. */
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('[data-note-delete]')) return;
  const question = (form.dataset.confirm || '').replace('{title}', () => noteTitleOf(form));
  if (question && !window.confirm(question)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

if (dialog) {
  const heading = dialog.querySelector('[data-note-view-title]');
  const body = dialog.querySelector('[data-note-view-body]');
  const content = dialog.querySelector('[data-note-view-content]');
  const status = dialog.querySelector('[data-note-view-status]');
  const pageLink = dialog.querySelector('[data-note-view-page]');
  const closeButton = dialog.querySelector('[data-note-view-close]');
  let opener = null;
  let sequence = 0;
  let writing = false;

  const say = (text) => { status.textContent = text; status.hidden = !text; };
  const fetchPage = (url, options = {}) =>
    // no-referrer would send Origin: null on POST, which the write guard rejects.
    fetch(url, { credentials: 'same-origin', referrerPolicy: 'same-origin', ...options });
  const messageOf = (html) => {
    const main = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
    return [...(main?.querySelectorAll('h1, h2, p') ?? [])].map((node) => node.textContent.trim())
      .filter(Boolean).slice(0, 2).join(' — ');
  };
  const noteUrl = (href) => {
    const url = new URL(href, location.href);
    return url.origin === location.origin && NOTE.test(url.pathname) ? url.pathname : null;
  };

  /** Shows a fetched note page's panel; false when the page has none. */
  const show = (html, url) => {
    const panel = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-note-view-panel]');
    if (!panel) return false;
    content.replaceChildren(document.importNode(panel, true));
    showDelete(content);
    const title = panel.querySelector('.document-heading h1')?.textContent?.trim();
    heading.textContent = title || heading.dataset.fallback || '';
    pageLink.href = url;
    pageLink.hidden = false;
    say('');
    body.scrollTop = 0;
    return true;
  };

  const load = async (url) => {
    const id = ++sequence;
    body.setAttribute('aria-busy', 'true');
    content.replaceChildren();
    pageLink.hidden = true;
    heading.textContent = heading.dataset.fallback || '';
    say(status.dataset.loading);
    try {
      const response = await fetchPage(url);
      const html = await response.text();
      if (id !== sequence || !dialog.open) return;
      if (!response.ok || !show(html, url)) say(messageOf(html) || status.dataset.error);
    } catch {
      if (id === sequence && dialog.open) say(status.dataset.error);
    } finally {
      if (id === sequence) body.removeAttribute('aria-busy');
    }
  };

  const open = (url) => {
    if (!dialog.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    load(url);
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element) || event.button !== 0 || event.metaKey
      || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download') || link.matches('[data-note-view-page]')) return;
    // A form's own links (Cancel on the edit page) leave the page as written.
    if (link.closest('form, .card-panel')) return;
    const url = noteUrl(link.href);
    if (!url) return;
    // Another dialog (search, quick note, a card) keeps its own links; this one follows links inside itself.
    const other = [...document.querySelectorAll('dialog[open]')].some((node) => node !== dialog);
    if (other) return;
    // On the note's own page the link is already open.
    if (!dialog.open && url === location.pathname) return;
    event.preventDefault();
    open(url);
  });

  content.addEventListener('submit', async (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || (!form.matches('.note-pin-form') && !form.matches('[data-note-delete]'))) return;
    event.preventDefault();
    if (writing) return;
    const deleting = form.matches('[data-note-delete]');
    const pinnedChange = form.matches('.note-pin-form');
    const submit = form.querySelector('button[type="submit"]');
    writing = true;
    if (submit) submit.disabled = true;
    try {
      const response = await fetchPage(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)) });
      const target = response.url ? new URL(response.url, location.origin) : null;
      const html = await response.text();
      if (deleting && response.redirected && target?.origin === location.origin && target.pathname === '/notes') {
        writing = false;
        dialog.close();
        toast(status.dataset.deleted || '');
        document.dispatchEvent(new CustomEvent('pinned:refresh'));
        document.dispatchEvent(new CustomEvent('notes:changed', { detail: { deleted: true } }));
        return;
      }
      if (!deleting && response.ok && response.redirected && target && noteUrl(target.href)
        && show(html, target.pathname)) {
        if (pinnedChange) document.dispatchEvent(new CustomEvent('pinned:refresh'));
        document.dispatchEvent(new CustomEvent('notes:changed'));
        return;
      }
      say(messageOf(html) || status.dataset.actionError);
    } catch {
      say(status.dataset.actionError);
    } finally {
      writing = false;
      if (submit?.isConnected) submit.disabled = false;
    }
  });

  closeButton?.addEventListener('click', () => { if (!writing) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (writing) event.preventDefault(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog || writing) return;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    sequence++;
    content.replaceChildren();
    say('');
    const target = opener;
    opener = null;
    if (target?.isConnected) target.focus();
  });
}
