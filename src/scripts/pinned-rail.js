// Wide-screen pinned-notes rail: visibility persistence, Escape, inert sync, fetch unpin + undo.
const RAIL_KEY = 'cairn-pinned-rail';
const root = document.documentElement;
const rail = document.querySelector('[data-pinned-panel]');
const tab = document.querySelector('[data-pinned-tab]');

if (rail && tab) {
  const wide = matchMedia('(min-width: 90rem)');
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
    || root.dataset.motion === 'less';
  const closeButton = rail.querySelector('[data-pinned-close]');
  const status = rail.querySelector('[data-pinned-status]');
  const body = rail.querySelector('[data-pinned-body]');
  let busy = false;
  let undoState = null;

  const isClosed = () => root.dataset.pinnedRail === 'closed';

  function syncInert() {
    if (!wide.matches) {
      rail.inert = true;
      tab.inert = true;
      return;
    }
    const closed = isClosed();
    rail.inert = closed;
    tab.inert = !closed;
  }

  function syncCount() {
    const list = rail.querySelector('[data-pinned-list]');
    const empty = rail.querySelector('[data-pinned-empty]');
    const items = list ? list.querySelectorAll('[data-pinned-item]').length : 0;
    const text = String(items);
    const railCount = rail.querySelector('[data-pinned-count]');
    const tabCount = tab.querySelector('[data-pinned-tab-count]');
    if (railCount) railCount.textContent = text;
    if (tabCount) tabCount.textContent = text;
    if (tab.dataset.label) tab.setAttribute('aria-label', tab.dataset.label.replace('{n}', text));
    if (list) list.hidden = items === 0;
    if (empty) empty.hidden = items > 0;
  }

  function setOpen(open, moveFocus = false) {
    root.dataset.pinnedRail = open ? 'open' : 'closed';
    try { localStorage.setItem(RAIL_KEY, open ? 'open' : 'closed'); } catch { /* Ignore storage failures. */ }
    syncInert();
    if (moveFocus) (open ? closeButton : tab)?.focus({ preventScroll: true });
  }

  function showError() {
    if (!status) return;
    undoState = null;
    status.textContent = rail.dataset.pinError || '';
  }

  function showUndo(title) {
    if (!status) return;
    status.replaceChildren();
    const message = document.createElement('span');
    message.textContent = (rail.dataset.unpinned || '').replace('{title}', title);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pinned-rail-undo';
    button.dataset.pinnedUndo = '';
    button.textContent = rail.dataset.undo || 'Undo';
    status.append(message, button);
  }

  const pauseLive = () => { root.dataset.livePaused = 'true'; };
  const resumeLive = () => {
    delete root.dataset.livePaused;
    document.dispatchEvent(new CustomEvent('live:resume'));
  };

  const waitCollapse = (row) => new Promise((resolve) => {
    if (reducedMotion() || !wide.matches) { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      row.removeEventListener('transitionend', onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === row && event.propertyName === 'grid-template-rows') finish();
    };
    row.addEventListener('transitionend', onEnd);
    const timer = setTimeout(finish, 400);
  });

  async function refreshBody(focusRef = null) {
    const response = await fetch(location.href, { credentials: 'same-origin' });
    if (!response.ok) return false;
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const nextBody = page.querySelector('[data-pinned-body]');
    if (!nextBody || !body) return false;
    body.replaceChildren(...nextBody.childNodes.length
      ? [...nextBody.childNodes].map((node) => document.importNode(node, true)) : []);
    syncCount();
    syncInert();
    if (focusRef) {
      const target = [...rail.querySelectorAll('[data-pinned-item]')]
        .find((item) => item.dataset.ref === focusRef)?.querySelector('.pinned-rail-link');
      target?.focus({ preventScroll: true });
    }
    return true;
  }

  async function postPin(action, data) {
    const response = await fetch(action, {
      method: 'POST',
      credentials: 'same-origin',
      referrerPolicy: 'same-origin',
      body: new URLSearchParams(data),
    });
    const target = response.url ? new URL(response.url, location.origin) : null;
    if (!response.ok || !response.redirected || !target || target.origin !== location.origin
      || !target.pathname.startsWith('/notes/')) {
      return null;
    }
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const form = page.querySelector('.note-pin-form');
    return {
      csrf: form?.querySelector('input[name="csrf"]')?.value || data.get('csrf') || '',
      revision: form?.querySelector('input[name="revision"]')?.value || '',
    };
  }

  closeButton?.addEventListener('click', () => setOpen(false, true));
  tab.addEventListener('click', () => setOpen(true, true));
  rail.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!wide.matches || isClosed() || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    setOpen(false, true);
  });

  rail.addEventListener('submit', async (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form?.matches('[data-pinned-form]')) return;
    event.preventDefault();
    if (busy) return;
    const row = form.closest('[data-pinned-item]');
    const submit = form.querySelector('button[type="submit"]');
    if (!row || !submit) return;
    const nextTarget = row.nextElementSibling?.querySelector('.pinned-rail-link')
      ?? row.previousElementSibling?.querySelector('.pinned-rail-link')
      ?? closeButton;
    busy = true;
    submit.disabled = true;
    undoState = null;
    if (status) status.textContent = '';
    pauseLive();
    const formData = new FormData(form);
    const collapse = waitCollapse(row);
    row.classList.add('is-leaving');
    try {
      const [result] = await Promise.all([postPin(form.action, formData), collapse]);
      if (!result) {
        row.classList.remove('is-leaving');
        submit.disabled = false;
        showError();
        return;
      }
      const ref = row.dataset.ref || '';
      const title = row.dataset.title || '';
      row.remove();
      syncCount();
      if (result.revision) {
        undoState = { ref, title, action: form.action, csrf: result.csrf, revision: result.revision };
        showUndo(title);
      }
      if (nextTarget?.isConnected) nextTarget.focus({ preventScroll: true });
    } catch {
      await collapse;
      row.classList.remove('is-leaving');
      submit.disabled = false;
      showError();
    } finally {
      busy = false;
      resumeLive();
    }
  });

  rail.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-pinned-undo]') : null;
    if (!button || busy || !undoState) return;
    busy = true;
    button.disabled = true;
    const pending = undoState;
    try {
      const data = new URLSearchParams({ csrf: pending.csrf, pinned: 'on', revision: pending.revision });
      const result = await postPin(pending.action, data);
      if (!result) {
        button.disabled = false;
        showError();
        return;
      }
      undoState = null;
      if (status) status.textContent = '';
      await refreshBody(pending.ref);
    } catch {
      button.disabled = false;
      showError();
    } finally {
      busy = false;
    }
  });

  wide.addEventListener('change', syncInert);
  document.addEventListener('live:updated', () => { syncCount(); syncInert(); });
  document.addEventListener('pinned:refresh', () => { void refreshBody(); });
  syncCount();
  syncInert();
}
