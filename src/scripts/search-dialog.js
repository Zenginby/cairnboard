// The ⌘K search dialog. AppShell draws the dialog with every text (data-* attributes); this file only adds
// behaviour. Rows are built with textContent; `snippetHtml` is the only field ever set as HTML (the server
// lets through nothing but <mark>).
const dialog = document.querySelector('[data-search-dialog]');
const opener = document.querySelector('[data-search-open]');
// On /search a live update replaces <main>, so the page's field and list are looked up at the moment of use.
const searchPage = document.body.hasAttribute('data-search-page');
const pageField = () => document.querySelector('#search-query');
const RECENT_KEY = 'cairn.recent-searches.v1';
const RECENT_LIMIT = 8;
const DELAY_MS = 120;
const MAX_QUERY = 200;
const TYPES = ['card', 'note', 'research'];
const PATHS = { card: 'cards', note: 'notes', research: 'research' };

const isMac = /mac|iphone|ipad/iu.test(navigator.userAgentData?.platform || navigator.platform || '');
const fill = (template, values) => template.replace(/\{(\w+)\}/gu,
  (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
const typing = (target) => target instanceof Element
  && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
const searchHref = (q, type) => `/search?${new URLSearchParams(type ? { q, type } : { q })}`;

for (const key of document.querySelectorAll('[data-shortcut]')) key.textContent = isMac ? '⌘K' : 'Ctrl K';

// Recent searches: [{ q, starred }], starred first. Storage may be missing or throw on every access; then the
// list stays hidden and nothing is reported.
function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.q === 'string' && item.q.trim())
      .map((item) => ({ q: item.q.slice(0, MAX_QUERY), starred: item.starred === true }));
  } catch {
    return null;
  }
}
function writeRecent(list) {
  const starred = list.filter((item) => item.starred).slice(0, RECENT_LIMIT);
  const plain = list.filter((item) => !item.starred).slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([...starred, ...plain]));
    return true;
  } catch {
    return false;
  }
}
function remember(q) {
  const query = q.trim();
  const list = readRecent();
  if (!query || !list) return;
  const old = list.find((item) => item.q === query);
  writeRecent([{ q: query, starred: old?.starred === true }, ...list.filter((item) => item.q !== query)]
    .sort((a, b) => Number(b.starred) - Number(a.starred)));
}
function toggleStar(q) {
  const list = readRecent();
  if (!list) return;
  const item = list.find((entry) => entry.q === q);
  if (!item) return;
  const rest = list.filter((entry) => entry !== item);
  const next = { q, starred: !item.starred };
  // A starred search goes to the top; an unstarred one to the top of the plain ones.
  writeRecent(next.starred ? [next, ...rest]
    : [...rest.filter((entry) => entry.starred), next, ...rest.filter((entry) => !entry.starred)]);
}
function forget(q) {
  const list = readRecent();
  if (list) writeRecent(list.filter((entry) => entry.q !== q));
}

const svg = (paths) => {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', d);
    icon.append(path);
  }
  return icon;
};
const STAR = 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z';

// Fills a recent-searches list. `choose(q)` runs when a query is picked; the page passes none and keeps the link.
// `onEmpty()` takes focus when the last entry is removed.
function renderRecent(container, texts, choose, onEmpty) {
  const list = readRecent();
  container.replaceChildren();
  if (!list?.length) return false;
  const full = list.filter((item) => item.starred).length >= RECENT_LIMIT;
  for (const item of list) {
    const row = document.createElement('li');
    row.className = 'search-recent-item';
    row.classList.toggle('is-starred', item.starred);
    const link = document.createElement('a');
    link.className = 'search-recent-query';
    link.href = searchHref(item.q);
    link.textContent = item.q;
    if (choose) link.addEventListener('click', (event) => { event.preventDefault(); choose(item.q); });
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'search-recent-star';
    star.setAttribute('aria-pressed', String(item.starred));
    star.setAttribute('aria-label', `${item.starred ? texts.unstar : texts.star}: ${item.q}`);
    star.append(svg([STAR]));
    // At the limit a ninth search cannot be starred; the button stays focusable and says why.
    const blocked = full && !item.starred;
    if (blocked) {
      star.setAttribute('aria-disabled', 'true');
      star.title = texts.starLimit;
    }
    star.addEventListener('click', () => {
      if (blocked) return;
      toggleStar(item.q);
      refresh(container, texts, choose, onEmpty, 'star', item.q);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'search-recent-remove';
    remove.setAttribute('aria-label', `${texts.remove}: ${item.q}`);
    remove.append(svg(['M6 6l12 12M18 6 6 18']));
    remove.addEventListener('click', () => refresh(container, texts, choose, onEmpty, 'remove', item.q));
    row.append(link, star, remove);
    container.append(row);
  }
  return true;
}
// Re-renders after a star or remove and keeps keyboard focus inside the list.
function refresh(container, texts, choose, onEmpty, action, q) {
  if (action === 'remove') forget(q);
  const index = [...container.children].findIndex((row) => row.querySelector('a')?.textContent === q);
  const shown = renderRecent(container, texts, choose, onEmpty);
  container.closest('[data-search-recent]')?.toggleAttribute('hidden', !shown);
  if (!container.closest('[data-search-recent]')) container.hidden = !shown;
  if (!shown) { onEmpty?.(); return; }
  if (action === 'star') {
    const row = [...container.children].find((item) => item.querySelector('a')?.textContent === q);
    row?.querySelector('.search-recent-star')?.focus();
  } else {
    const rows = [...container.children];
    rows[Math.min(index, rows.length - 1)]?.querySelector('a')?.focus();
  }
}

const texts = dialog ? { ...dialog.dataset } : {};
const labels = { card: texts.cards, note: texts.notes, research: texts.research };
const kinds = { card: texts.kindCard, note: texts.kindNote, research: texts.kindResearch };

// The /search page: ⌘K, `/` and the top bar link focus the page's own field; the dialog never opens there.
if (searchPage) {
  const focusField = () => {
    const field = pageField();
    field?.focus();
    field?.select();
  };
  opener?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    focusField();
  });
  document.addEventListener('keydown', (event) => {
    const command = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      focusField();
    } else if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !typing(event.target)) {
      event.preventDefault();
      focusField();
    }
  });
  const drawRecent = () => {
    const recent = document.querySelector('[data-recent-searches]');
    if (recent) recent.hidden = !renderRecent(recent, texts, null, focusField);
  };
  drawRecent();
  // live-updates.js swapped <main>: the server's list is empty again.
  document.addEventListener('live:updated', drawRecent);
  document.addEventListener('submit', (event) => {
    const field = pageField();
    if (field && event.target instanceof HTMLFormElement && event.target === field.form) remember(field.value);
  });
  document.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('main .search-row') : null;
    if (row) remember(pageField()?.value ?? '');
  });
} else if (dialog) {
  const input = dialog.querySelector('[data-search-input]');
  const status = dialog.querySelector('[data-search-status]');
  const retry = dialog.querySelector('[data-search-retry]');
  const recentBox = dialog.querySelector('[data-search-recent]');
  const recentList = dialog.querySelector('[data-search-recent-list]');
  const results = dialog.querySelector('[data-search-results]');
  const all = dialog.querySelector('[data-search-all]');
  let returnTo = null;
  let timer = 0;
  let sequence = 0;
  let controller = null;
  let shownKey = '';
  let active = -1;
  // `shownQuery`: the query the visible list answers; `inflight`: the query being fetched; `openWhenReady`: Enter
  // came while the list was stale, so the first result of the current query opens when it arrives.
  let shownQuery = null;
  let inflight = null;
  let openWhenReady = false;
  const currentQuery = () => Array.from(input.value).slice(0, MAX_QUERY).join('').trim();

  const options = () => [...results.querySelectorAll('[role="option"]')];
  // -1: no active row yet; the first ArrowDown makes the first row active.
  const setActive = (index) => {
    const list = options();
    active = list.length && index >= 0 ? Math.min(index, list.length - 1) : -1;
    list.forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
    if (active < 0) input.removeAttribute('aria-activedescendant');
    else {
      input.setAttribute('aria-activedescendant', list[active].id);
      list[active].scrollIntoView({ block: 'nearest' });
    }
  };
  const showStatus = (text, canRetry = false) => {
    status.textContent = text;
    retry.hidden = !canRetry;
  };
  const clearResults = () => {
    sequence++;
    controller?.abort();
    controller = null;
    clearTimeout(timer);
    inflight = null;
    openWhenReady = false;
    results.replaceChildren();
    results.hidden = true;
    results.removeAttribute('aria-busy');
    shownKey = '';
    shownQuery = null;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  };
  const showRecent = () => {
    clearResults();
    showStatus(texts.emptyHint);
    recentBox.hidden = !renderRecent(recentList, texts, (q) => {
      input.value = q;
      input.focus();
      update(true);
    }, () => input.focus());
    all.href = '/search';
  };

  const option = (id, href, className) => {
    const item = document.createElement('li');
    item.id = id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    item.className = className;
    item.dataset.href = href;
    return item;
  };
  const span = (className, text) => {
    const node = document.createElement('span');
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const toneOf = (project) => (Number.isInteger(project?.tone) && project.tone >= 1 && project.tone <= 8
    ? project.tone : 7);
  const rowOption = (row, id) => {
    const item = option(id, `/${PATHS[row.type]}/${encodeURIComponent(row.ref)}`, 'search-row');
    const top = span('search-row-top');
    top.append(span('search-row-title', row.title || texts.untitled),
      span(`chip search-row-kind search-row-kind--${row.type}`, kinds[row.type]));
    const enter = span('search-row-enter', '↵');
    enter.setAttribute('aria-hidden', 'true');
    top.append(enter);
    item.append(top);
    if (typeof row.snippetHtml === 'string' && row.snippetHtml) {
      const snippet = span('search-row-snippet');
      snippet.innerHTML = row.snippetHtml;
      item.append(snippet);
    }
    if (row.project || row.column || row.updated) {
      const meta = span('search-row-meta');
      if (row.project) {
        const project = span(`search-row-project tone-${toneOf(row.project)}`);
        const dot = span('search-row-dot');
        dot.setAttribute('aria-hidden', 'true');
        project.append(dot, document.createTextNode(row.project.name || texts.untitled));
        meta.append(project);
      }
      if (row.column) meta.append(span('search-row-column', row.column));
      if (row.updated) {
        const time = document.createElement('time');
        time.className = 'search-row-date';
        time.dateTime = String(row.updated);
        time.textContent = String(row.updated).slice(0, 10);
        meta.append(time);
      }
      item.append(meta);
    }
    return item;
  };

  const render = (q, data) => {
    const groups = TYPES.map((type) => ({ type, rows: data.results?.[type] ?? [], more: data.more?.[type],
      count: data.counts?.[type] ?? 0 })).filter((group) => group.rows.length);
    const key = JSON.stringify(groups.map((group) => [group.type, group.rows.map((row) => row.ref), group.more]));
    const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
    const counted = TYPES.map((type) => data.counts?.[type] ?? 0);
    const capped = counted.some((count) => typeof count === 'string');
    const sum = counted.reduce((acc, count) => acc + Number.parseInt(String(count), 10), 0);
    showStatus(total ? fill(texts.count, { n: capped ? `${sum}+` : sum }) : texts.noResults);
    const activeHref = options()[active]?.dataset.href;
    // Same rows as before: only the texts (highlights) may change, nothing fades or jumps.
    const fresh = key !== shownKey;
    const nodes = groups.map((group) => {
      const section = document.createElement('div');
      section.className = 'search-section';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-labelledby', `search-dialog-group-${group.type}`);
      const heading = span('search-group', labels[group.type]);
      heading.id = `search-dialog-group-${group.type}`;
      heading.setAttribute('role', 'presentation');
      const list = document.createElement('ul');
      list.className = 'search-rows';
      list.setAttribute('role', 'presentation');
      group.rows.forEach((row, i) => list.append(rowOption(row, `search-dialog-${group.type}-${i}`)));
      if (group.more) {
        const label = labels[group.type].toLocaleLowerCase(texts.lang);
        const more = option(`search-dialog-${group.type}-more`, searchHref(q, group.type), 'search-more-option');
        more.append(span('search-more-label', fill(texts.more, { type: label, n: group.count })));
        list.append(more);
      }
      section.append(heading, list);
      return section;
    });
    results.replaceChildren(...nodes);
    results.hidden = total === 0;
    input.setAttribute('aria-expanded', String(total > 0));
    results.removeAttribute('aria-busy');
    shownQuery = q;
    if (fresh) {
      shownKey = key;
      results.classList.remove('is-fresh');
      void results.offsetWidth;
      results.classList.add('is-fresh');
      setActive(-1);
    } else setActive(options().findIndex((item) => item.dataset.href === activeHref));
    if (openWhenReady) {
      openWhenReady = false;
      const first = options()[0];
      if (first) go(first.dataset.href);
    }
  };

  const search = async (q) => {
    const id = ++sequence;
    controller?.abort();
    controller = new AbortController();
    inflight = q;
    const { signal } = controller;
    try {
      const response = await fetch(`/api/search?${new URLSearchParams({ q, limit: '5' })}`,
        { credentials: 'same-origin', signal, headers: { accept: 'application/json' } });
      const body = response.status === 409 ? null : await response.json().catch(() => null);
      // An answer for anything but the field's current text is never drawn.
      if (id !== sequence || q !== currentQuery()) return;
      inflight = null;
      if (response.status === 409) { clearResults(); showStatus(texts.notReady); return; }
      if (!response.ok || !body?.ok) throw new Error(`HTTP ${response.status}`);
      render(q, body.data);
    } catch {
      // A newer query aborted this one, or its answer came too late: say nothing.
      if (id !== sequence || signal.aborted) return;
      clearResults();
      showStatus(texts.failed, true);
    }
  };

  // `now` skips the typing delay (a picked recent search, the retry button).
  // Every change makes the visible list stale at once: the request in flight is dropped and Enter waits.
  function update(now = false) {
    const q = currentQuery();
    sequence++;
    controller?.abort();
    controller = null;
    inflight = null;
    openWhenReady = false;
    clearTimeout(timer);
    all.href = q ? searchHref(q) : '/search';
    if (!q) { showRecent(); return; }
    recentBox.hidden = true;
    if (shownQuery !== q) results.setAttribute('aria-busy', 'true');
    if (now) search(q);
    else timer = setTimeout(() => search(q), DELAY_MS);
  }

  // `trigger`: the element clicked to open; a mouse click does not focus a link in every browser (Safari).
  const open = (trigger = null) => {
    if (dialog.open) { input.focus(); input.select(); return; }
    returnTo = trigger ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null);
    dialog.showModal();
    input.focus();
    input.select();
    update(true);
  };
  const go = (href) => {
    if (!href) return;
    remember(input.value);
    location.assign(href);
  };

  opener?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(opener);
  });
  document.addEventListener('keydown', (event) => {
    const command = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      open();
    } else if (event.key === '/' && !dialog.open && !event.metaKey && !event.ctrlKey && !event.altKey
      && !typing(event.target)) {
      event.preventDefault();
      open();
    }
  });
  input.addEventListener('input', () => update());
  input.addEventListener('keydown', (event) => {
    const list = options();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!input.value.trim() && event.key === 'ArrowDown' && !recentBox.hidden) {
        recentList.querySelector('a')?.focus();
        return;
      }
      // Up on the first row leaves no active row.
      if (list.length) setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if ((event.key === 'Home' || event.key === 'End') && (event.ctrlKey || (isMac && event.metaKey))
      && list.length) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : list.length - 1);
    } else if (event.key === 'Enter') {
      // Enter while an input method composes belongs to the composition.
      if (event.isComposing) return;
      event.preventDefault();
      const q = currentQuery();
      if (!q) return;
      // Without an active row Enter opens the first result.
      if (shownQuery === q && !results.hasAttribute('aria-busy')) {
        if (list.length) go((list[active] ?? list[0]).dataset.href);
        return;
      }
      openWhenReady = true;
      if (inflight !== q) { clearTimeout(timer); search(q); }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (input.value) { input.value = ''; update(); } else dialog.close();
    }
  });
  // Arrow keys also walk the recent searches; Up from the first goes back to the field.
  recentList.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...recentList.querySelectorAll('a')];
    const row = event.target instanceof Element ? event.target.closest('li') : null;
    const index = links.indexOf(row?.querySelector('a') ?? null);
    if (index < 0) return;
    event.preventDefault();
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) input.focus();
    else links[Math.min(next, links.length - 1)].focus();
  });
  results.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    if (item instanceof HTMLElement) go(item.dataset.href);
  });
  results.addEventListener('mousemove', (event) => {
    const item = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    const index = options().indexOf(item);
    if (index >= 0 && index !== active) setActive(index);
  });
  retry.addEventListener('click', () => { input.focus(); update(true); });
  all.addEventListener('click', () => remember(input.value));
  // A click on the backdrop (the dialog box itself, outside its panel) closes it.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    const target = returnTo;
    clearResults();
    returnTo = null;
    if (target?.isConnected) target.focus();
    else if (target) document.querySelector('#main')?.focus();
  });
}
