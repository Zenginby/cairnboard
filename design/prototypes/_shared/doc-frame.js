import { $, el, button, field, loadData, setupUI, renderState, projectChip } from './app-ui.js';

export { $, el, button, field, projectChip };
export function link(text, href, className = '') {
  const node = el('a', className, text);
  node.href = href;
  return node;
}
export const recordHref = (record) => `../${record.kind === 'research' ? 'research-item' : 'note'}/?id=${encodeURIComponent(record.id)}`;
export const kindNames = { note: 'Not', wiki: 'Wiki', research: 'Araştırma' };
export function section(title, id) {
  const node = el('section', 'doc-section');
  const heading = el('h2', '', title);
  heading.id = id;
  node.append(heading);
  return node;
}
export function references(records) {
  const grid = el('div', 'doc-references');
  records.forEach((record) => {
    const item = link('', record.href, 'doc-reference');
    item.append(el('span', 'doc-reference-kind', record.kind), el('span', 'doc-reference-name', record.title), el('span', 'doc-reference-detail', record.detail));
    grid.append(item);
  });
  return grid;
}
function safeHref(value) {
  try {
    const url = new URL(value, location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch { return '#'; }
}
function inline(parent, text, notes) {
  const pattern = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    if (match[1]) {
      const record = notes.find((item) => item.title === match[1]);
      parent.append(link(match[1], record ? recordHref(record) : `../notes/?q=${encodeURIComponent(match[1])}`));
    } else if (match[2]) parent.append(link(match[2], safeHref(match[3])));
    else parent.append(el(match[4] ? 'code' : 'strong', '', match[4] || match[5]));
    start = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}
// A deliberately small Markdown subset, built only with DOM nodes; raw HTML stays text.
export function renderMarkdown(text, notes = []) {
  const root = el('div', 'markdown');
  const lines = text.split('\n');
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((value) => value.trim());
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith('```')) {
      const pre = el('pre');
      const code = el('code');
      const content = [];
      while (++index < lines.length && !lines[index].startsWith('```')) content.push(lines[index]);
      code.textContent = content.join('\n');
      pre.append(code); root.append(pre); index++; continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-+/.test(lines[index + 1] || '')) {
      const wrap = el('div', 'doc-table-wrap');
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', 'Markdown tablosu');
      const table = el('table');
      const head = el('thead');
      const row = el('tr');
      cells(line).forEach((text) => { const cell = el('th'); cell.scope = 'col'; inline(cell, text, notes); row.append(cell); });
      head.append(row); table.append(head);
      const body = el('tbody');
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = el('tr');
        cells(lines[index++]).forEach((text) => { const cell = el('td'); inline(cell, text, notes); row.append(cell); });
        body.append(row);
      }
      table.append(body); wrap.append(table); root.append(wrap); continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) { const node = el(heading[1].length < 3 ? 'h2' : 'h3'); inline(node, heading[2], notes); root.append(node); index++; continue; }
    const list = line.match(/^\s*(-|\d+\.)\s+(.+)/);
    if (list) {
      const ordered = list[1] !== '-';
      const node = el(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = lines[index].match(ordered ? /^\s*\d+\.\s+(.+)/ : /^\s*-\s+(.+)/);
        if (!item) break;
        const li = el('li'); inline(li, item[1], notes); node.append(li); index++;
      }
      root.append(node); continue;
    }
    const paragraph = el('p');
    inline(paragraph, line, notes); root.append(paragraph); index++;
  }
  return root;
}
export function noteGroups(ctx, research = false) {
  const notes = ctx.data.notes.filter((record) => !record.trashed && (research ? record.kind === 'research' : record.kind !== 'research'));
  const entries = (records) => records.map((record) => ({ title: ctx.text(record.title), href: recordHref(record), current: record.id === ctx.record?.id }));
  return [
    { title: research ? 'Araştırmalar' : 'Sabitlenenler', entries: [{ title: research ? 'Bütün araştırmalar' : 'Bütün notlar', href: `../${research ? 'research' : 'notes'}/`, current: !ctx.record }, ...entries(research ? notes : notes.filter((record) => record.pinned))] },
    ...(!research ? [{ title: 'Son notlar', entries: entries(notes.slice(0, 4)) }] : []),
    ...ctx.data.projects.filter((project) => notes.some((record) => record.projectId === project.id)).map((project) => ({ title: project.name, entries: entries(notes.filter((record) => record.projectId === project.id)) }))
  ];
}
function sidebar(ctx, groups, project) {
  const root = $('#doc-sidebar');
  const previous = new Map([...root.querySelectorAll('.sidebar-group')].map((group) => [group.dataset.name, group.dataset.open]));
  root.replaceChildren();
  if (project) {
    const picker = el('div', 'project-switcher');
    picker.append(el('p', '', 'Proje değiştir'));
    const list = el('ul');
    ctx.data.projects.forEach((item) => {
      const li = el('li');
      const anchor = link(item.name, `../project/?project=${encodeURIComponent(item.id)}`);
      if (project.id === item.id) anchor.setAttribute('aria-current', 'page');
      li.append(anchor); list.append(li);
    });
    picker.append(list, link('Tüm projeler', '../projects/')); root.append(picker);
  }
  groups.forEach((group, index) => {
    const wrapper = el('section', 'sidebar-group');
    wrapper.dataset.name = group.title;
    wrapper.dataset.open = previous.get(group.title) || 'true';
    const content = el('div', 'sidebar-group-content');
    content.id = `sidebar-group-${index}`;
    const inner = el('div', 'sidebar-group-inner');
    const list = el('ul');
    group.entries.forEach((entry) => {
      const item = el('li');
      const anchor = link(entry.title, entry.href);
      if (entry.current) anchor.setAttribute('aria-current', 'page');
      item.append(anchor); list.append(item);
    });
    inner.append(list); content.append(inner);
    content.inert = wrapper.dataset.open !== 'true';
    content.setAttribute('aria-hidden', String(content.inert));
    const toggle = button('', (event) => {
      const open = wrapper.dataset.open !== 'true';
      wrapper.classList.toggle('is-instant', event.detail === 0);
      wrapper.dataset.open = String(open);
      content.inert = !open;
      content.setAttribute('aria-hidden', String(!open));
      toggle.setAttribute('aria-expanded', String(open));
    }, 'sidebar-group-toggle');
    toggle.setAttribute('aria-controls', content.id);
    toggle.setAttribute('aria-expanded', wrapper.dataset.open);
    toggle.append(el('span', '', group.title), el('span', 'sidebar-chevron', '⌄'));
    wrapper.append(toggle, content); root.append(wrapper);
  });
}
export function markdownEditor(ctx, value, save, cancel) {
  const root = el('div', 'stack');
  const columns = el('div', 'doc-editor');
  const source = field('Markdown', 'textarea');
  source.control.value = value;
  const preview = el('section', 'doc-preview stack');
  preview.setAttribute('aria-label', 'Canlı önizleme');
  const content = el('div');
  const update = () => content.replaceChildren(renderMarkdown(source.control.value, ctx.data.notes));
  preview.append(el('p', '', 'Canlı önizleme'), content);
  source.control.addEventListener('input', update); update();
  columns.append(source.wrapper, preview);
  root.append(columns);
  const actions = el('div', 'row');
  actions.append(button('Kaydet', () => {
    if (!ctx.canWrite()) return;
    save(source.control.value);
  }, 'button button--primary'), button('İptal', cancel));
  root.append(actions);
  return { node: root, control: source.control };
}
export function documentList(ctx, records, { research = false } = {}) {
  const root = el('div', 'document-list');
  const filters = el('div', 'document-filters');
  const query = field('Metin ara'); query.control.type = 'search';
  query.control.value = new URLSearchParams(location.search).get('q') || '';
  const project = field('Proje', 'select');
  const all = el('option', '', 'Bütün projeler'); all.value = ''; project.control.append(all);
  ctx.data.projects.filter((item) => records.some((record) => record.projectId === item.id)).forEach((item) => { const option = el('option', '', item.name); option.value = item.id; project.control.append(option); });
  const initial = new URLSearchParams(location.search).get('project');
  if ([...project.control.options].some((option) => option.value === initial)) project.control.value = initial;
  filters.append(query.wrapper, project.wrapper); root.append(filters);
  const kinds = el('div', 'row document-kinds');
  kinds.setAttribute('role', 'group'); kinds.setAttribute('aria-label', research ? 'Araştırma türü' : 'Not türü');
  const result = el('p', 'type-label muted'); result.setAttribute('role', 'status');
  const list = el('ul', 'document-rows');
  let type = '';
  const kindFor = (record) => research ? record.type || 'İnceleme' : kindNames[record.kind] || 'Not';
  const rows = records.map((record) => {
    const item = el('li');
    const meta = el('div', 'row document-meta');
    const time = el('time', '', record.updated || '3 Kasım'); time.dateTime = record.date || '2026-11-03';
    meta.append(el('span', 'document-badge', kindFor(record)), time);
    const owner = ctx.data.projects.find((project) => project.id === record.projectId);
    if (owner) meta.append(el('span', 'document-badge', owner.name));
    item.append(link(ctx.text(record.title), recordHref(record), 'document-title'), meta, el('p', '', ctx.text(record.body || '')));
    list.append(item); return { item, record };
  });
  const empty = el('p', 'muted', 'Sonuç yok. Başka bir metin veya proje seçin.');
  const filter = () => {
    const term = query.control.value.toLocaleLowerCase('tr').trim();
    rows.forEach(({ item, record }) => { item.hidden = Boolean(type && kindFor(record) !== type || project.control.value && record.projectId !== project.control.value || !item.textContent.toLocaleLowerCase('tr').includes(term)); });
    const count = rows.filter(({ item }) => !item.hidden).length;
    result.textContent = `${count} ${research ? 'belge' : 'not'}`; empty.hidden = count > 0;
  };
  ['', ...new Set(records.map(kindFor))].forEach((kind) => {
    const count = kind ? records.filter((record) => kindFor(record) === kind).length : records.length;
    const chip = button(`${kind || 'Tümü'} (${count})`, () => { type = kind; [...kinds.children].forEach((node) => node.setAttribute('aria-pressed', String(node === chip))); filter(); }, 'button document-kind');
    chip.setAttribute('aria-pressed', String(!kind)); kinds.append(chip);
  });
  query.control.addEventListener('input', filter); project.control.addEventListener('change', filter);
  root.append(kinds, result, list, empty); filter();
  return root;
}

export function startDocument(options) {
  const data = { cards: [], notes: [], people: [], projects: [] };
  let state = 'loading';
  let fixtures;
  let headings = [];
  let scrollFrame;
  let initialized = false;
  const ctx = {
    data,
    get state() { return state; },
    get record() { return options.record?.(ctx); },
    get body() { return $('#doc-body'); },
    text: (value) => state === 'long' ? `${value} — ${data.longText.title}` : value,
    refresh: () => render(),
    setState: (value) => setState(value),
    focus: (selector = '#main') => requestAnimationFrame(() => $(selector)?.focus({ preventScroll: true })),
    canWrite: () => {
      if (state === 'locked') { ctx.toast('claude üzerinde çalışıyor. Kilit kalkana kadar düzenlenemez.'); return false; }
      if (state === 'conflict') { $('#conflict').hidden = false; ctx.toast('Bu dosya dışarıda değişti. Kaydetmeden önce yeniden yükleyin veya farkı inceleyin.'); return false; }
      return true;
    },
    header: (title, source, markdown, cover = false) => {
      const header = $('#doc-heading');
      const row = el('div', `doc-title-row${cover ? ' project-cover' : ''}`);
      const heading = el('h1', '', ctx.text(title)); heading.id = 'doc-title';
      const actions = el('div', 'doc-raw-actions');
      const raw = (event) => ctx.ui.open('Ham Markdown', [el('pre', 'doc-raw type-code', markdown())], null, event.detail === 0);
      const copy = button("Markdown'ı kopyala", async () => {
        try { await navigator.clipboard.writeText(markdown()); copy.textContent = 'Kopyalandı'; ctx.toast('Markdown kopyalandı.'); }
        catch { const area = field('Kopyalanacak Markdown', 'textarea'); area.control.value = markdown(); area.control.readOnly = true; ctx.ui.open('Markdown’ı seçip kopyalayın', [area.wrapper], null, true); area.control.select(); }
      }, 'button doc-pill');
      actions.append(copy, button('Ham', raw, 'button doc-pill'));
      row.append(heading, actions);
      const info = el('p', 'doc-source');
      info.append('Kaynak: ', el('code', '', source), ' · değişti: 3 Kasım 2026 · ');
      const open = link('Kaynakta aç', '#');
      open.addEventListener('click', (event) => { event.preventDefault(); raw(event); });
      info.append(open); header.replaceChildren(row, info);
    },
    toast: (text, undo) => {
      ctx.ui.announce(text);
      let notice = $('#doc-notice');
      if (!notice) { notice = el('div', 'toast is-open row doc-notice'); notice.id = 'doc-notice'; document.body.append(notice); }
      notice.replaceChildren(el('span', '', text));
      if (undo) notice.append(button('Geri al', () => { undo(); notice.remove(); ctx.focus(); ctx.ui.announce('İşlem geri alındı.'); }));
      notice.append(button('Kapat', () => { notice.remove(); ctx.focus(); }));
    },
    confirm: (title, description, action, label = 'Onayla') => ctx.ui.open(title, [el('p', '', description)], () => { if (!ctx.canWrite()) return false; action(); }, false, label),
    updateTOC: () => updateTOC()
  };
  ctx.ui = setupUI(data, (kind) => { setState('full'); options.created?.(ctx, kind); }, (instant) => ctx.ui.create('card', instant));
  const mobile = matchMedia('(width < 50rem)');
  const toggle = $('#sidebar-toggle');
  const setSidebar = (open, restore = false) => {
    const sidebar = $('#doc-sidebar');
    sidebar.hidden = mobile.matches && !open;
    sidebar.inert = mobile.matches && !open;
    toggle.setAttribute('aria-expanded', String(mobile.matches ? open : true));
    if (restore) toggle.focus();
  };
  toggle.addEventListener('click', () => setSidebar(toggle.getAttribute('aria-expanded') !== 'true'));
  mobile.addEventListener('change', () => { const focused = $('#doc-sidebar').contains(document.activeElement); setSidebar(false, focused && mobile.matches); });
  $('#doc-sidebar').addEventListener('keydown', (event) => { if (event.key === 'Escape' && mobile.matches) setSidebar(false, true); });
  setSidebar(false);
  // The shared shortcuts stay available for search, but cannot bypass document locks.
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable="true"]') || !['n', 'c'].includes(event.key.toLowerCase())) return;
    if (!fixtures || ['locked', 'conflict'].includes(state)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (fixtures) ctx.canWrite();
    }
  }, true);
  function spy() {
    scrollFrame = null;
    const headerHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height'));
    const clearance = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-lg'));
    let current = headings[0];
    headings.forEach((heading) => { if (heading.getBoundingClientRect().top <= headerHeight + clearance * 2) current = heading; });
    const currentId = customToc?.current?.() || current?.id;
    $('#doc-toc').querySelectorAll('a').forEach((anchor) => anchor.setAttribute('aria-current', String(anchor.hash === `#${currentId}`)));
  }
  // A page whose content is not a run of headings (the journal calendar) can supply its own contents:
  // options.toc(ctx) returns { items: [{ title, id, level, select }], current() }.
  let customToc = null;
  function updateTOC() {
    customToc = options.toc?.(ctx) || null;
    if (customToc) {
      headings = customToc.items.filter((item) => item.level === 2).map((item) => document.getElementById(item.id)).filter(Boolean);
      const toc = $('#doc-toc'); toc.hidden = !customToc.items.length;
      const list = el('ul');
      customToc.items.forEach((entry) => {
        const item = el('li'); item.dataset.level = String(entry.level);
        const anchor = link(entry.title, `#${entry.id}`);
        anchor.addEventListener('click', (event) => {
          if (!entry.select) return;
          event.preventDefault(); entry.select();
        });
        item.append(anchor); list.append(item);
      });
      toc.replaceChildren(el('h2', '', 'Sayfa içeriği'), list); spy();
      return;
    }
    headings = [...ctx.body.querySelectorAll('.markdown h2, .markdown h3, .doc-section > h2')].filter((heading) => !heading.closest('.doc-editor'));
    const toc = $('#doc-toc'); toc.hidden = !headings.length;
    const list = el('ul');
    const ids = new Set([...document.querySelectorAll('[id]')].map((node) => node.id));
    headings.forEach((heading) => {
      if (!heading.id) {
        const slug = heading.textContent.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'heading';
        const base = `section-${slug}`;
        let id = base;
        let suffix = 2;
        while (ids.has(id)) id = `${base}-${suffix++}`;
        heading.id = id; ids.add(id);
      }
      heading.tabIndex = -1;
      const item = el('li'); item.dataset.level = heading.tagName.slice(1);
      const anchor = link(heading.textContent, `#${heading.id}`);
      anchor.addEventListener('click', () => heading.focus({ preventScroll: true }));
      item.append(anchor); list.append(item);
    });
    toc.replaceChildren(el('h2', '', 'Sayfa içeriği'), list); spy();
  }
  addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(spy); }, { passive: true });
  addEventListener('resize', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(spy); });
  function render() {
    if (!fixtures) return;
    const navigation = options.sidebar?.(ctx) || { groups: [] };
    sidebar(ctx, navigation.groups, navigation.project);
    options.render(ctx);
    updateTOC();
  }
  function setState(value) {
    state = value; $('#prototype-state').value = value;
    renderState(value, () => setState('full'), () => options.firstStep ? options.firstStep(ctx) : ctx.ui.create('note'));
    if (value === 'empty') {
      $('#state-content p')?.replaceChildren(options.emptyMessage || 'Henüz kayıt yok. İlk notunuzu ekleyerek başlayın.');
      const first = $('#state-content button'); if (first) first.textContent = options.emptyLabel || 'Not ekle';
    }
    render();
  }
  $('#prototype-state').addEventListener('change', (event) => {
    if (!fixtures) return;
    Object.assign(data, structuredClone(fixtures)); options.reset?.(ctx, event.target.value); setState(event.target.value);
  });
  $('#diff-open').addEventListener('click', (event) => {
    event.stopImmediatePropagation();
    const current = $('.doc-editor textarea')?.value ?? options.markdown?.(ctx) ?? ctx.record?.body ?? '';
    ctx.ui.open('Dosyadaki fark', [el('p', 'muted', 'Bu oturumdaki sürüm'), el('pre', 'doc-raw type-code', current), el('p', 'muted', 'Dışarıdaki sürüm'), el('pre', 'doc-raw type-code', `${current}\n\nDışarıda eklenen not: Birlikte yeniden gözden geçir.`), el('p', '', 'Yeniden yükle dışarıdaki örnek sürümü uygular; bu oturumdaki taslak kapanır.')], null, event.detail === 0);
  }, true);
  $('#reload').addEventListener('click', () => {
    options.reload?.(ctx); setState('full'); ctx.focus(); ctx.toast('Dosyanın dışarıdaki sürümü yüklendi.');
  });
  async function load() {
    renderState('loading', load, () => {});
    try {
      const [base, response] = await Promise.all([loadData(), fetch('../_shared/workspace.json')]);
      if (!response.ok) throw new Error('Workspace unavailable');
      const shared = await response.json();
      const merge = (kind) => [...new Map([...base[kind], ...shared[kind]].map((record) => [record.id, { ...base[kind].find((item) => item.id === record.id), ...record }])).values()];
      Object.assign(data, base, shared, { cards: merge('cards'), notes: merge('notes') });
      options.prepare?.(ctx);
      fixtures = structuredClone(data); initialized = true; setState('full');
      if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ behavior: 'instant' }));
    } catch {
      state = 'error'; $('#prototype-state').value = 'error'; renderState('error', load, () => {});
      if (!initialized) $('#doc-sidebar').replaceChildren(el('p', 'type-label muted', 'Sayfa menüsü yüklenemedi.'));
    }
  }
  load();
  return ctx;
}
