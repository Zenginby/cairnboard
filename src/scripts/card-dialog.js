// Board cards and "Add card" open in a dialog instead of a new page. The card page, its edit page and the new-card
// page stay the no-script fallback: the dialog fetches one, imports its `[data-card-panel]` and posts forms with fetch.
// A card opens in its reading view; Edit swaps in the edit form, and Save or Cancel return to the reading view.
// The board refreshes through live updates after a write (or a reload when those are off).
const dialog = document.querySelector('[data-card-dialog]');
const CARD = /^\/cards\/(c-[0-9a-hjkmnp-tv-z]{6})(\/edit)?$/u;

if (dialog) {
  const heading = dialog.querySelector('[data-card-dialog-title]');
  const body = dialog.querySelector('[data-card-dialog-body]');
  const content = dialog.querySelector('[data-card-dialog-content]');
  const status = dialog.querySelector('[data-card-dialog-status]');
  const projectLink = dialog.querySelector('[data-card-dialog-project]');
  let opener = null;
  let sequence = 0;
  let dirty = false;
  let writing = false;
  let changed = false;
  let current = null;

  const say = (text) => { status.textContent = text; status.hidden = !text; };
  // A card link opens the card's reading view (or its edit form for an /edit link); "Add card" the new-card form.
  const urlOf = (href) => {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return null;
    if (CARD.test(url.pathname) || url.pathname === '/cards/new') return `${url.pathname}${url.search}`;
    return null;
  };
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
  const kind = () => content.querySelector('[data-card-panel]')?.dataset.cardPanelKind ?? '';
  // The one-line status fields wrap, so long text stays readable; Enter never adds a line break.
  const fit = (field) => {
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  };

  const load = async (url) => {
    const id = ++sequence;
    current = url;
    body.setAttribute('aria-busy', 'true');
    say(content.childElementCount ? '' : status.dataset.loading);
    try {
      const response = await fetchPage(url);
      const html = await response.text();
      if (id !== sequence || !dialog.open) return;
      const panel = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-card-panel]');
      if (!response.ok || !panel) {
        content.replaceChildren();
        say(messageOf(html) || status.dataset.error);
        return;
      }
      const imported = document.importNode(panel, true);
      heading.textContent = panel.dataset.cardPanelTitle || heading.textContent;
      // "Go to project" belongs to the reading view of a card that has a project.
      const project = panel.dataset.cardPanelKind === 'read' ? panel.dataset.cardProjectHref : '';
      projectLink.hidden = !project;
      if (project) projectLink.href = project;
      content.replaceChildren(imported);
      body.scrollTop = 0;
      say('');
      dirty = false;
      for (const field of imported.querySelectorAll('.card-status-input')) fit(field);
      const field = imported.querySelector('.card-title-input');
      if (field) {
        field.focus();
        if (imported.dataset.cardPanelKind === 'edit') field.setSelectionRange(field.value.length, field.value.length);
      } else {
        imported.querySelector('[data-card-panel-edit]')?.focus();
      }
    } catch {
      if (id === sequence && dialog.open) say(status.dataset.error);
    } finally {
      if (id === sequence) body.setAttribute('aria-busy', 'false');
    }
  };

  const discardOk = () => !dirty || window.confirm(status.dataset.discard);
  const close = () => { if (!writing && discardOk()) dialog.close(); };
  // The reading view of the card the dialog shows, for Cancel and after a save.
  const readUrl = () => {
    const match = CARD.exec(new URL(current ?? '/', location.href).pathname);
    return match ? `/cards/${match[1]}` : null;
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey
      || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a.board-card, a.column-add') : null;
    if (!link || !link.closest('.board')) return;
    const url = urlOf(link.href);
    if (!url) return;
    event.preventDefault();
    if (dialog.open) return;
    opener = link;
    changed = false;
    content.replaceChildren();
    heading.textContent = '';
    projectLink.hidden = true;
    dialog.showModal();
    void load(url);
  });

  content.addEventListener('input', (event) => {
    dirty = true;
    if (event.target instanceof HTMLTextAreaElement && event.target.matches('.card-status-input')) {
      const field = event.target;
      if (/[\r\n]/u.test(field.value)) field.value = field.value.replace(/[\r\n]+/gu, ' ');
      fit(field);
    }
  });
  content.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target instanceof Element && event.target.matches('.card-status-input')) {
      event.preventDefault();
    }
  });
  content.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    const cancel = event.target.closest('[data-card-panel-cancel]');
    if (cancel) {
      event.preventDefault();
      // Cancel on an edit form goes back to reading the card; on the new-card form it closes the dialog.
      const back = kind() === 'edit' ? readUrl() : null;
      if (!back) close();
      else if (discardOk()) void load(back);
      return;
    }
    // Edit, and links to other cards (related cards), stay in the dialog.
    const link = event.target.closest('a[href]');
    const url = link && urlOf(link.href);
    if (url && url !== '/cards/new') {
      event.preventDefault();
      if (discardOk()) void load(url);
    }
  });
  content.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (writing) return;
    writing = true;
    const panelKind = kind();
    const buttons = [...form.querySelectorAll('button[type="submit"]')];
    for (const button of buttons) button.disabled = true;
    body.setAttribute('aria-busy', 'true');
    say('');
    let done = false;
    try {
      // A write answers 303; with `manual` that is an opaque redirect. Anything else is a refusal page.
      const response = await fetchPage(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)),
        redirect: 'manual' });
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        done = true;
        changed = true;
        dirty = false;
      } else {
        say(messageOf(await response.text()) || status.dataset.saveError);
      }
    } catch {
      say(status.dataset.saveError);
    } finally {
      writing = false;
      body.setAttribute('aria-busy', 'false');
      for (const button of buttons) button.disabled = false;
    }
    if (!done) return;
    // A new card closes the dialog; an edit, a checked item or a comment shows the card as it is now.
    const back = panelKind === 'new' ? null : readUrl();
    if (back) void load(back);
    else dialog.close();
  });

  dialog.querySelector('[data-card-dialog-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { if (writing || !discardOk()) event.preventDefault(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) close();
  });
  dialog.addEventListener('close', () => {
    sequence += 1;
    dirty = false;
    current = null;
    content.replaceChildren();
    say('');
    // Without live updates the board would not show what changed.
    if (changed && !document.querySelector('[data-live-status]')) location.reload();
    if (opener?.isConnected) opener.focus();
    else document.getElementById(opener?.closest('li')?.id ?? '')?.querySelector('a')?.focus();
  });
}
