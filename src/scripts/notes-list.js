// Notes page: title search, and the row pin and delete buttons posted with fetch so the page stays put.
// Without script the forms post normally (pin opens the note, delete comes back here).
import { normalizeSearch } from './search-text.js';
import { toast } from './toast.js';

const page = document.querySelector('[data-notes-page]');

if (page) {
  const main = document.querySelector('main');
  const live = () => Boolean(document.querySelector('main[data-live]'));
  let busy = false;

  const filter = () => {
    const input = document.querySelector('[data-notes-search]');
    const empty = document.querySelector('[data-notes-search-empty]');
    if (!input) return;
    const query = normalizeSearch(input.value, input.dataset.lang || document.documentElement.lang || 'tr');
    let shown = 0;
    for (const group of document.querySelectorAll('[data-notes-group]')) {
      let count = 0;
      for (const item of group.querySelectorAll('[data-notes-item]')) {
        const title = item.querySelector('.row-title')?.textContent ?? '';
        const match = !query || normalizeSearch(title, input.dataset.lang || 'tr').includes(query);
        item.hidden = !match;
        if (match) count++;
      }
      group.hidden = count === 0;
      const counter = group.querySelector('[data-notes-count]');
      if (counter) counter.textContent = String(count);
      shown += count;
    }
    if (empty) empty.textContent = query && shown === 0 ? empty.dataset.text || '' : '';
  };

  // Live updates swap the list (and keep the typed query). Without them the page reloads after a change, once the
  // note dialog is closed; a delete comes back with the notice the script-free page shows.
  const viewer = document.querySelector('[data-note-view]');
  let reloadAfterDialog = false;
  const reload = (deleted = false) => {
    if (deleted) {
      const url = new URL(location.href);
      url.searchParams.set('deleted', '1');
      location.assign(url);
    } else if (viewer?.open) {
      reloadAfterDialog = true;
    } else {
      location.reload();
    }
  };
  viewer?.addEventListener('close', () => { if (reloadAfterDialog) location.reload(); });
  const changed = (event) => { if (!live()) reload(event?.detail?.deleted === true); };

  /** After a pin the row's forms take the note's new revision and pinned state from the note page answer. */
  const refreshRow = (row, html) => {
    const answer = new DOMParser().parseFromString(html, 'text/html').querySelector('.note-pin-form');
    const revision = answer?.querySelector('input[name="revision"]')?.value;
    const next = answer?.querySelector('input[name="pinned"]')?.value;
    if (!row || !revision || !next) return;
    for (const field of row.querySelectorAll('input[name="revision"]')) field.value = revision;
    const pin = row.querySelector('[data-notes-pin]');
    const nextField = pin?.querySelector('input[name="pinned"]');
    if (nextField) nextField.value = next;
    pin?.querySelector('button')?.setAttribute('aria-pressed', String(next === 'off'));
  };

  main?.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-notes-search]')) filter();
  });
  document.addEventListener('live:updated', filter);
  document.addEventListener('notes:changed', changed);

  main?.addEventListener('submit', async (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || (!form.matches('[data-notes-pin]') && !form.matches('[data-notes-delete]'))) return;
    event.preventDefault();
    if (busy) return;
    const deleting = form.matches('[data-notes-delete]');
    const button = form.querySelector('button');
    busy = true;
    if (button) button.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        referrerPolicy: 'same-origin',
        body: new URLSearchParams(new FormData(form)),
      });
      const target = response.url ? new URL(response.url, location.origin) : null;
      const done = response.redirected && target?.origin === location.origin
        && (deleting ? target.pathname === '/notes' : target.pathname.startsWith('/notes/'));
      if (!done) {
        toast(page.dataset.actionError || '');
        return;
      }
      const row = form.closest('[data-notes-item]');
      document.dispatchEvent(new CustomEvent('pinned:refresh'));
      if (deleting) {
        toast(page.dataset.deleted || '');
        row?.remove();
        filter();
      } else {
        refreshRow(row, await response.text());
      }
      changed({ detail: { deleted: deleting } });
    } catch {
      toast(page.dataset.actionError || '');
    } finally {
      busy = false;
      if (button?.isConnected) button.disabled = false;
    }
  });

  // A delete that came back here without script says so once; the address drops the flag.
  if (new URL(location.href).searchParams.get('deleted') === '1') {
    const url = new URL(location.href);
    url.searchParams.delete('deleted');
    history.replaceState(history.state, '', url);
  }
  filter();
}
