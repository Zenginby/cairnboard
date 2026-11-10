const region = document.querySelector('[data-live]');
const status = document.querySelector('[data-live-status]');
// Only these fields get their typed value back after a swap; a checkbox or file input keeps the server's.
const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);
const isTextField = (element) => element?.tagName === 'TEXTAREA'
  || (element?.tagName === 'INPUT' && TEXT_TYPES.has(String(element.type || 'text').toLowerCase()));

if (region && status) {
  let source, retryTimer, statusTimer, reconcileRequest;
  let failures = 0, refreshing = false, pending = false, retryStep = 0, lastFocus = 0;
  let resume = document.visibilityState !== 'visible';
  const retryDelays = [2000, 5000, 15_000, 60_000];
  const showStatus = (text, temporary = false) => {
    clearTimeout(statusTimer);
    status.textContent = text;
    if (temporary) statusTimer = setTimeout(() => { status.textContent = ''; }, 3000);
  };

  async function update() {
    if (document.visibilityState !== 'visible') return;
    pending = true;
    if (refreshing) return;
    refreshing = true;
    try {
      while (pending) {
        pending = false;
        const connection = source;
        const response = await fetch(location.href, { credentials: 'same-origin' });
        if (!response.ok && response.status !== 404) continue;
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const next = page.querySelector('[data-live]');
        if (!next || document.visibilityState !== 'visible' || source !== connection) continue;
        document.title = page.title;
        if (region.innerHTML === next.innerHTML) continue;
        const active = document.activeElement;
        const focusId = region.contains(active) ? active.id : null;
        const field = focusId && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
          ? { value: active.value, start: active.selectionStart, end: active.selectionEnd, text: isTextField(active) }
          : null;
        // Keep drafts even after focus moved to another control; hidden tokens and non-text fields stay fresh.
        const drafts = [...region.querySelectorAll('input, textarea')]
          .filter((element) => element.id && isTextField(element) && element.value !== element.defaultValue)
          .map((element) => [element.id, element.value]);
        const href = region.contains(active) ? active.getAttribute('href') : null;
        const scroll = [window.scrollX, window.scrollY];
        const scrollable = [...region.querySelectorAll('*')].filter((element) => element.scrollLeft || element.scrollTop)
          .map((element) => [element.id, element.className, element.scrollLeft, element.scrollTop]);
        region.replaceChildren(...next.childNodes);
        for (const [id, value] of drafts) {
          const element = document.getElementById(id);
          if (region.contains(element) && isTextField(element)) element.value = value;
        }
        // Scripts that fill parts of the region (recent searches on /search) redraw them before focus returns.
        // (Guarded: test/live-client.test.mjs runs this file against a document without events.)
        if (typeof CustomEvent === 'function') document.dispatchEvent?.(new CustomEvent('live:updated'));
        let focus = focusId ? document.getElementById(focusId)
          : href ? [...region.querySelectorAll('[href]')].find((element) => element.getAttribute('href') === href) : null;
        if (focus && !region.contains(focus)) focus = null;
        if (focus) {
          if (field?.text && isTextField(focus)) {
            try { focus.value = field.value; } catch { /* Keep the server's value. */ }
          }
          focus.focus({ preventScroll: true });
          if (field) {
            try { focus.setSelectionRange(field.start, field.end); }
            catch { /* Some input types do not support selection. */ }
          }
        }
        else if (active !== region && !active.isConnected) region.focus({ preventScroll: true });
        for (const [id, className, left, top] of scrollable) {
          const element = id ? document.getElementById(id)
            : [...region.querySelectorAll('*')].find((item) => item.className === className);
          element?.scrollTo({ left, top, behavior: 'instant' });
        }
        window.scrollTo({ left: scroll[0], top: scroll[1], behavior: 'instant' });
        showStatus(status.dataset.updated, true);
      }
    } catch { /* A later change or focus will retry; keep the current page usable. */ }
    finally { refreshing = false; }
  }

  function reconcile() {
    if (document.visibilityState !== 'visible') return Promise.resolve();
    if (reconcileRequest) return reconcileRequest;
    if (Date.now() - lastFocus < 1000) return Promise.resolve();
    lastFocus = Date.now();
    reconcileRequest = fetch('/api/reconcile', { credentials: 'same-origin' }).catch(() => {})
      .finally(() => { reconcileRequest = undefined; });
    return reconcileRequest;
  }

  // HEAD answers without opening a stream. Only a definite 404 counts; any failure to ask means "try again".
  const probe = () => fetch('/api/events', { method: 'HEAD', credentials: 'same-origin' })
    .then((response) => response.status === 404, () => false);

  function connect(recover = false) {
    if (source || document.visibilityState !== 'visible') return;
    const current = new EventSource('/api/events');
    source = current;
    let refreshOnOpen = recover;
    current.addEventListener('open', () => {
      if (source !== current) return;
      failures = retryStep = 0;
      showStatus('');
      // A not-ready page may have missed the one change sent when the data directory appeared.
      const refresh = refreshOnOpen || Boolean(region.querySelector('[data-not-ready]'));
      refreshOnOpen = false;
      void reconcile().then(() => { if (refresh && source === current) void update(); });
    });
    current.addEventListener('error', () => {
      if (source !== current) return;
      refreshOnOpen = true;
      if (++failures >= 3 || current.readyState === EventSource.CLOSED) showStatus(status.dataset.paused);
      if (current.readyState === EventSource.CLOSED) {
        current.close();
        source = undefined;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          // An EventSource cannot see the status. A 404 means live updates were switched off in the settings:
          // stop for good instead of retrying; a reload picks up the new state.
          probe().then((gone) => {
            if (gone) { showStatus(''); return; }
            connect(true);
          });
        }, retryDelays[Math.min(retryStep++, retryDelays.length - 1)]);
      }
    });
    current.addEventListener('change', (event) => {
      if (source !== current) return;
      try {
        const { kinds } = JSON.parse(event.data);
        if (kinds.some((kind) => region.dataset.live.split(' ').includes(kind))) void update();
      } catch { /* Ignore malformed events. */ }
    });
  }

  function suspend() {
    resume = true;
    source?.close();
    source = undefined;
    clearTimeout(retryTimer);
    clearTimeout(statusTimer);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') suspend();
    else { connect(resume); resume = false; }
  });
  window.addEventListener('focus', () => { void reconcile(); });
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', (event) => { if (event.persisted) connect(true); });
  connect();
}
