// The journal month page reads a day in a dialog and adds a job to today in another one. The day page and the
// calendar's ?day= preview stay the no-script fallback: the day dialog fetches /journal/<date>, imports its
// [data-journal-day-panel] and binds its "On this page" panel to the dialog body. The add dialog holds the server's
// JournalForm and posts it with fetch; a refusal page's short message is shown in the dialog.
import { initDocToc } from './doc-toc.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const NOTE_KEY = 'cairn:journal-added';
const dayDialog = document.querySelector('[data-journal-day-dialog]');
const addDialog = document.querySelector('[data-journal-add-dialog]');
const note = document.querySelector('[data-journal-note]');

const fetchPage = (url, options = {}) =>
  // no-referrer would send Origin: null on POST, which the write guard rejects.
  fetch(url, { credentials: 'same-origin', referrerPolicy: 'same-origin', ...options });
// The short message of a refusal page (PageState or the write error page), without the page chrome.
const messageOf = (html) => {
  const page = new DOMParser().parseFromString(html, 'text/html');
  const main = page.querySelector('main');
  const parts = [...(main?.querySelectorAll('h1, h2, p') ?? [])].map((node) => node.textContent.trim())
    .filter(Boolean).slice(0, 2);
  return parts.join(' — ');
};
const plainClick = (event) => !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey
  && !event.shiftKey && !event.altKey;
// A click on the dialog element itself outside its box is a click on the backdrop.
const onBackdrop = (dialog, event) => {
  if (event.target !== dialog) return false;
  const { left, right, top, bottom } = dialog.getBoundingClientRect();
  return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
};

// Live updates replace <main>; the dialogs and the note live outside it so an open dialog keeps its state.
// A swap brings fresh copies along, which are dropped again.
const portals = [dayDialog, addDialog, note].filter(Boolean);
for (const element of portals) document.body.append(element);
document.addEventListener('live:updated', () => {
  for (const element of document.querySelectorAll('main [data-journal-portal]')) element.remove();
});

let noteTimer;
const showNote = (text) => {
  if (!note) return;
  clearTimeout(noteTimer);
  note.textContent = text;
  noteTimer = setTimeout(() => { note.textContent = ''; }, 4000);
};
try {
  if (sessionStorage.getItem(NOTE_KEY)) {
    sessionStorage.removeItem(NOTE_KEY);
    showNote(note?.dataset.added ?? '');
  }
} catch { /* Storage may be off; the note is only a courtesy. */ }

if (dayDialog) {
  const heading = dayDialog.querySelector('[data-journal-dialog-title]');
  const body = dayDialog.querySelector('[data-journal-dialog-body]');
  const content = dayDialog.querySelector('[data-journal-dialog-content]');
  const status = dayDialog.querySelector('[data-journal-dialog-status]');
  const full = dayDialog.querySelector('[data-journal-dialog-full]');
  const steps = {
    previous: dayDialog.querySelector('[data-journal-dialog-step="previous"]'),
    next: dayDialog.querySelector('[data-journal-dialog-step="next"]'),
  };
  const stepText = Object.fromEntries(Object.entries(steps).map(([key, button]) => [key, button.textContent]));
  const title = heading.textContent;
  let opener = null;
  let sequence = 0;
  let returnUrl = null;

  const say = (text) => { status.textContent = text; };
  const setStep = (key, date, label) => {
    const button = steps[key];
    button.disabled = !date;
    button.dataset.date = date ?? '';
    // The day the button goes to is part of its name, so it reads "Previous day: 2 November 2026".
    if (date && label) button.setAttribute('aria-label', `${stepText[key]}: ${label}`);
    else button.removeAttribute('aria-label');
  };
  const remember = (date) => {
    const url = new URL(location.href);
    url.searchParams.set('day', date);
    url.searchParams.set('month', date.slice(0, 7));
    url.hash = '';
    history.replaceState(history.state, '', url);
  };

  const load = async (date) => {
    const id = ++sequence;
    body.setAttribute('aria-busy', 'true');
    full.href = `/journal/${date}`;
    say(status.dataset.loading);
    try {
      const response = await fetchPage(`/journal/${encodeURIComponent(date)}`);
      const html = await response.text();
      if (id !== sequence || !dayDialog.open) return;
      const panel = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-journal-day-panel]');
      if (!response.ok || !panel) {
        content.replaceChildren();
        heading.textContent = title;
        setStep('previous', null);
        setStep('next', null);
        say(messageOf(html) || status.dataset.error);
        return;
      }
      const imported = document.importNode(panel, true);
      const data = imported.dataset;
      heading.textContent = data.journalDayTitle || title;
      setStep('previous', data.journalDayPrevious, data.journalDayPreviousLabel);
      setStep('next', data.journalDayNext, data.journalDayNextLabel);
      // Reaching the first or last day disables the step in use; focus moves to its partner instead of the page.
      for (const [key, button] of Object.entries(steps)) {
        if (button.disabled && document.activeElement === button) {
          const other = steps[key === 'previous' ? 'next' : 'previous'];
          (other.disabled ? dayDialog.querySelector('[data-journal-dialog-close]') : other).focus();
        }
      }
      // The contents scroll the dialog body, not the window, and leave the page's hash alone.
      for (const toc of imported.querySelectorAll('[data-doc-toc]')) {
        toc.setAttribute('data-doc-toc-root', '[data-journal-dialog-body]');
      }
      content.replaceChildren(imported);
      body.scrollTop = 0;
      say('');
      initDocToc(content);
      remember(date);
    } catch {
      if (id === sequence && dayDialog.open) say(status.dataset.error);
    } finally {
      if (id === sequence) body.setAttribute('aria-busy', 'false');
    }
  };

  const open = (date, from) => {
    if (dayDialog.open || addDialog?.open) return;
    opener = from;
    returnUrl = location.href;
    content.replaceChildren();
    heading.textContent = title;
    setStep('previous', null);
    setStep('next', null);
    dayDialog.showModal();
    // Focus starts on the close button: it reads the dialog's title first and Esc or Enter leaves at once.
    dayDialog.querySelector('[data-journal-dialog-close]').focus();
    void load(date);
  };

  // Delegated on the document: the calendar and the list are inside <main>, which live updates replace.
  document.addEventListener('click', (event) => {
    if (!plainClick(event) || !(event.target instanceof Element)) return;
    const trigger = event.target.closest('[data-journal-day]');
    if (!trigger || !trigger.closest('main')) return;
    const date = trigger.getAttribute('data-journal-day') ?? '';
    if (!DATE.test(date)) return;
    event.preventDefault();
    open(date, trigger);
  });

  for (const button of Object.values(steps)) {
    button.addEventListener('click', () => {
      const date = button.dataset.date;
      if (date && DATE.test(date)) void load(date);
    });
  }
  dayDialog.querySelector('[data-journal-dialog-close]').addEventListener('click', () => dayDialog.close());
  dayDialog.addEventListener('click', (event) => { if (onBackdrop(dayDialog, event)) dayDialog.close(); });
  dayDialog.addEventListener('close', () => {
    sequence += 1;
    content.replaceChildren();
    say('');
    body.setAttribute('aria-busy', 'false');
    initDocToc(content);
    if (returnUrl) history.replaceState(history.state, '', returnUrl);
    returnUrl = null;
    if (opener?.isConnected) opener.focus();
    else {
      // A live update replaced the calendar: focus the same day's trigger in the new one.
      const date = opener?.getAttribute('data-journal-day');
      const again = date && document.querySelector(`main [data-journal-day="${date}"]`);
      if (again instanceof HTMLElement) again.focus();
    }
    opener = null;
  });
}

if (addDialog) {
  const body = addDialog.querySelector('[data-journal-add-body]');
  const status = addDialog.querySelector('[data-journal-add-status]');
  const form = addDialog.querySelector('form');
  let opener = null;
  let writing = false;
  let dirty = false;

  const say = (text) => { status.textContent = text; };
  const discardOk = () => !dirty || window.confirm(status.dataset.discard);
  const close = () => { if (!writing && discardOk()) addDialog.close(); };

  document.addEventListener('click', (event) => {
    if (!plainClick(event) || !(event.target instanceof Element)) return;
    const link = event.target.closest('[data-journal-add-open]');
    if (!link || !link.closest('main')) return;
    event.preventDefault();
    if (addDialog.open || dayDialog?.open) return;
    opener = link;
    say('');
    addDialog.showModal();
    form.querySelector('input[name="title"]')?.focus();
  });
  // With scripts the link acts as a button that opens a dialog.
  const markOpeners = () => {
    for (const link of document.querySelectorAll('main [data-journal-add-open]')) {
      link.setAttribute('aria-haspopup', 'dialog');
    }
  };
  markOpeners();
  document.addEventListener('live:updated', markOpeners);

  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (writing) return;
    writing = true;
    const buttons = [...form.querySelectorAll('button[type="submit"]')];
    for (const button of buttons) button.disabled = true;
    body.setAttribute('aria-busy', 'true');
    say('');
    let done = false;
    try {
      // A write answers 303; with `manual` that is an opaque redirect. Anything else is a refusal page.
      const response = await fetchPage(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)),
        redirect: 'manual' });
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) done = true;
      else say(messageOf(await response.text()) || status.dataset.saveError);
    } catch {
      say(status.dataset.saveError);
    } finally {
      writing = false;
      body.setAttribute('aria-busy', 'false');
      for (const button of buttons) button.disabled = false;
    }
    if (!done) {
      form.querySelector('input[name="title"]')?.focus();
      return;
    }
    dirty = false;
    form.reset();
    addDialog.close();
    // Live updates redraw the month on their own; without them the page reloads and shows the note after.
    if (document.querySelector('[data-live-status]')) showNote(note?.dataset.added ?? '');
    else {
      try { sessionStorage.setItem(NOTE_KEY, '1'); } catch { /* The reload still shows the new job. */ }
      location.reload();
    }
  });

  addDialog.querySelector('[data-journal-add-close]').addEventListener('click', close);
  addDialog.addEventListener('cancel', (event) => { if (writing || !discardOk()) event.preventDefault(); });
  addDialog.addEventListener('click', (event) => { if (onBackdrop(addDialog, event)) close(); });
  addDialog.addEventListener('close', () => {
    // Closing was confirmed (or nothing was typed): the next opening starts with an empty form.
    form.reset();
    dirty = false;
    say('');
    if (opener?.isConnected) opener.focus();
    else document.querySelector('main [data-journal-add-open]')?.focus();
    opener = null;
  });
}
