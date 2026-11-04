import { $, el, button, loadData, setupUI, renderState } from '../_shared/app-ui.js';

let data;
let fixtures;
let page;
let ui;
let state = 'full';
const filters = { query: '', kind: 'all', machine: 'all', unused: false, sort: 'name' };
const copy = {
  empty: ['Henüz tarama yapılmadı', 'Kurulu ajanlar, skill\'ler, eklentiler ve MCP sunucuları ilk taramadan sonra burada listelenir. Taramayı bu komut yapacak:'],
  loading: ['Araçlar yükleniyor', 'Skill klasörleri ve oturum kayıtları okunuyor.'],
  error: ['Araçlar okunamadı', 'Tarama sonuçları dosyası açılamadı. Dosya yerinde mi bak, sonra yeniden dene.'],
};
const skillStates = {
  current: ['güncel', 'chip--done'],
  outdated: ['eski sürüm', 'chip--warning'],
  missing: ['kurulu değil', 'chip--danger'],
  unread: ['okunamadı', 'chip--planned'],
};
const collator = new Intl.Collator('tr');
const kindOf = (id) => page.kinds.find((kind) => kind.id === id);
const machineOf = (id) => page.machines.find((machine) => machine.id === id);
const isStale = (machineId) => state === 'partial' && machineId === page.partial.machine;
const nameOf = (tool, index) => (state === 'long' && index % 3 === 0 ? page.longText.name : tool.name);
const descriptionOf = (tool, index) => (state === 'long' && index % 2 === 0 ? `${tool.description} ${page.longText.description}` : tool.description);
const installCommand = (tool) => `cairn agent install --target ${tool.name}`;
const clockFormat = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' });
const daysBetween = (iso) => Math.round((new Date(new Date(page.now).toDateString()) - new Date(new Date(iso).toDateString())) / 86400000);

function scanTime(iso) {
  const date = new Date(iso);
  const time = clockFormat.format(date).replace(':', '.');
  const days = daysBetween(iso);
  if (days === 0) return `Bugün ${time}`;
  if (days === 1) return `Dün ${time}`;
  return `${dayFormat.format(date)} ${time}`;
}
function agoText(iso) {
  const days = daysBetween(iso);
  if (days <= 0) return 'bugün';
  if (days === 1) return 'dün';
  if (days < 30) return `${days} gün önce`;
  return `${Math.floor(days / 30)} ay önce`;
}
function dot(machine) {
  const node = el('span', 'tools-dot');
  node.setAttribute('aria-hidden', 'true');
  node.style.setProperty('--dot', `var(--color-tone-${machine.tone})`);
  return node;
}
function statusChip(status) {
  const [label, tone] = skillStates[status];
  return el('span', `chip ${tone}`, label);
}
function matches(tool, index) {
  const query = filters.query.trim().toLocaleLowerCase('tr');
  if (filters.kind !== 'all' && tool.kind !== filters.kind) return false;
  if (filters.machine !== 'all' && !tool.machines.includes(filters.machine)) return false;
  if (filters.unused && tool.usage) return false;
  return !query || `${nameOf(tool, index)} ${descriptionOf(tool, index)}`.toLocaleLowerCase('tr').includes(query);
}
function visibleTools() {
  const list = page.tools.map((tool, index) => ({ tool, index })).filter(({ tool, index }) => matches(tool, index));
  const byName = (a, b) => collator.compare(a.tool.name, b.tool.name);
  // Most recent first; tools that were never used go last, by name.
  const usedAt = ({ tool }) => (tool.usage ? Date.parse(tool.usage.lastUsed) : 0);
  const byUse = (a, b) => usedAt(b) - usedAt(a) || byName(a, b);
  return list.sort(filters.sort === 'used' ? byUse : byName);
}
function cell(className, label) {
  const node = el('span', `tools-cell ${className}`);
  node.setAttribute('role', 'cell');
  if (label) node.append(el('span', 'tools-mobile-label', label));
  return node;
}
async function copyCommand(command, trigger, code) {
  const label = trigger.querySelector('.tools-copy-label');
  try {
    await navigator.clipboard.writeText(command);
    label.textContent = 'Kopyalandı';
    ui.announce(`“${command}” panoya kopyalandı.`);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    label.textContent = 'Seçildi';
    ui.announce('Komut seçildi. Kopyalamak için ⌘C ya da Ctrl+C bas.');
  }
  clearTimeout(trigger.timer);
  trigger.timer = setTimeout(() => { label.textContent = 'Kopyala'; }, 2000);
}
function skillCell(tool, name) {
  if (tool.kind !== 'agent') {
    const none = cell('tools-cell--none');
    none.append(el('span', 'tools-none', '—'), el('span', 'sr-only', 'Ajan olmadığı için Cairnboard skill\'i gerekmez'));
    none.firstChild.setAttribute('aria-hidden', 'true');
    return none;
  }
  const node = cell('tools-cell--skill', 'Cairnboard skill\'i');
  const list = el('ul', 'tools-skills');
  tool.machines.forEach((id) => {
    const machine = machineOf(id);
    const status = isStale(id) ? 'unread' : tool.skill[id];
    const item = el('li', 'tools-skill');
    const line = el('div', 'tools-skill-line');
    line.append(el('span', 'tools-skill-machine', machine.name), statusChip(status));
    item.append(line);
    if (status === 'outdated' || status === 'missing') {
      const command = installCommand(tool);
      const action = el('div', 'tools-action');
      const code = el('code', 'tools-code', command);
      const trigger = button('', () => copyCommand(command, trigger, code), 'button tools-copy');
      trigger.append(el('span', 'tools-copy-label', 'Kopyala'), el('span', 'sr-only', ` (${machine.name}, ${name} komutu)`));
      action.append(code, trigger);
      item.append(action);
    }
    list.append(item);
  });
  node.append(list);
  return node;
}
function row({ tool, index }) {
  const name = nameOf(tool, index);
  const node = el('div', 'tools-row tools-item');
  node.setAttribute('role', 'row');
  node.dataset.id = tool.id;
  const info = cell('tools-cell--name');
  const line = el('span', 'tools-name-line');
  const kind = kindOf(tool.kind);
  line.append(el('span', 'tools-title', name), el('span', `chip tools-kind chip--tone-${kind.tone}`, kind.label));
  info.append(line, el('span', 'tools-desc', descriptionOf(tool, index)));
  const machines = cell('tools-cell--machines', 'Makineler');
  const chips = el('span', 'tools-machines');
  tool.machines.forEach((id) => {
    const machine = machineOf(id);
    const stale = isStale(id);
    const chip = el('span', `chip tools-machine${stale ? ' tools-machine--stale' : ''}`);
    chip.append(dot(machine), document.createTextNode(stale ? `${machine.name} · eski kayıt` : machine.name));
    chips.append(chip);
  });
  machines.append(chips);
  const usage = cell('tools-cell--usage', 'Kullanım');
  if (tool.usage) {
    const text = el('span', 'tools-usage');
    const time = el('time', '', agoText(tool.usage.lastUsed));
    time.dateTime = tool.usage.lastUsed;
    time.title = `${dayFormat.format(new Date(tool.usage.lastUsed))}, ${clockFormat.format(new Date(tool.usage.lastUsed)).replace(':', '.')}`;
    text.append(document.createTextNode('son kullanım '), time, document.createTextNode(` · ${tool.usage.count.toLocaleString('tr-TR')} kez`));
    usage.append(text);
  } else usage.append(el('span', 'tools-usage tools-usage--none', 'hiç kullanılmadı'));
  node.append(info, machines, usage, skillCell(tool, name));
  return node;
}
function stat(kind) {
  const node = el('div', 'tools-tile');
  node.append(el('span', 'tools-tile-value', String(page.tools.filter((tool) => tool.kind === kind.id).length)), el('span', 'tools-tile-label', kind.label));
  return node;
}
function machineTile(machine) {
  const node = el('div', 'tools-tile tools-tile--machine');
  const label = el('span', 'tools-tile-label');
  label.append(dot(machine), document.createTextNode(machine.name));
  const partial = isStale(machine.id);
  const status = el('span', `chip ${partial ? 'chip--warning' : 'chip--done'}`, partial ? 'kısmen okunabildi' : 'okundu');
  const count = page.tools.filter((tool) => tool.machines.includes(machine.id)).length;
  const meta = el('span', 'tools-tile-meta counter');
  const time = el('time', '', scanTime(machine.lastScan));
  time.dateTime = machine.lastScan;
  meta.append(document.createTextNode(`${count} araç · son tarama: `), time);
  node.append(label, status, meta);
  return node;
}
function renderSummary() {
  const unused = page.tools.filter((tool) => !tool.usage).length;
  $('#tools-summary').textContent = `${page.tools.length} araç · ${page.machines.length} makine · ${unused} tanesi hiç kullanılmadı`;
  $('#tools-stats').replaceChildren(...page.kinds.map(stat), ...page.machines.map(machineTile));
  const partial = $('#tools-partial');
  partial.hidden = state !== 'partial';
  if (state !== 'partial') return;
  const machine = machineOf(page.partial.machine);
  const title = el('h2', '', 'Kısmen okunabildi');
  title.id = 'tools-partial-title';
  const badge = el('span', 'chip chip--warning');
  badge.append(title);
  const text = el('p', '', `${machine.name} taraması tamamlanamadı. ${page.partial.reason} Masaüstünden okunanlar güncel; ${machine.name} için ${scanTime(machine.lastScan)} tarihli eski kayıt gösteriliyor.`);
  partial.replaceChildren(badge, text, button('Taramayı yeniden dene', () => {
    setState('full');
    ui.announce(`${machine.name} yeniden tarandı; tüm makineler okundu.`);
    $('#main').focus({ preventScroll: true });
  }));
}
function renderList() {
  const list = visibleTools();
  const rows = $('#tools-rows');
  rows.replaceChildren(...list.map(row));
  if (!list.length) {
    const empty = el('div', 'tools-row tools-empty');
    empty.setAttribute('role', 'row');
    const message = cell('');
    message.append(el('p', '', 'Bu süzgeçlere uyan araç yok. Süzgeçleri temizle ya da başka bir sözcük dene.'));
    empty.append(message, button('Süzgeçleri temizle', clearFilters));
    rows.append(empty);
  }
  const active = filters.query.trim() || filters.kind !== 'all' || filters.machine !== 'all' || filters.unused;
  $('#tools-count').textContent = `${list.length} / ${page.tools.length} araç gösteriliyor`;
  $('#tools-clear').hidden = !active;
}
function clearFilters() {
  Object.assign(filters, { query: '', kind: 'all', machine: 'all', unused: false });
  syncControls();
  renderList();
  $('#tools-query').focus({ preventScroll: true });
}
function syncControls() {
  $('#tools-query').value = filters.query;
  $('#tools-kind').value = filters.kind;
  $('#tools-machine').value = filters.machine;
  $('#tools-unused').checked = filters.unused;
  $('#tools-sort').value = filters.sort;
}
function fillControls() {
  const option = (value, label) => { const node = el('option', '', label); node.value = value; return node; };
  $('#tools-kind').replaceChildren(option('all', 'Tümü'), ...page.kinds.map((kind) => option(kind.id, kind.label)));
  $('#tools-machine').replaceChildren(option('all', 'Tümü'), ...page.machines.map((machine) => option(machine.id, machine.name)));
  syncControls();
}
function renderEmpty() {
  const panel = $('#state-content');
  const planned = el('div', 'state-planned');
  planned.append(el('span', 'chip chip--planned', 'planlanan'), el('span', 'type-label muted', 'Bu komut henüz yok; araçlar eklentisiyle gelecek.'));
  panel.append(el('code', 'state-code type-code', 'cairn tools scan'), planned);
}
function render() {
  renderSummary();
  renderList();
}
function setState(value) {
  state = value;
  page = structuredClone(fixtures.page);
  if (value === 'empty') page.tools = [];
  $('#prototype-state').value = value;
  const special = ['empty', 'loading', 'error'].includes(value);
  renderState(value, () => setState('full'), null, copy);
  if (value === 'empty') renderEmpty();
  if (special) return;
  fillControls();
  render();
}
async function start() {
  try {
    const [loaded, response] = await Promise.all([loadData('../_shared/workspace.json'), fetch('data.json')]);
    if (!response.ok) throw new Error('Tools unavailable');
    data = loaded;
    fixtures = { page: await response.json() };
    ui = setupUI(data, () => {}, (instant) => ui.create('card', instant));
    $('#tools-toolbar').addEventListener('submit', (event) => event.preventDefault());
    $('#tools-query').addEventListener('input', (event) => { filters.query = event.target.value; renderList(); });
    $('#tools-kind').addEventListener('change', (event) => { filters.kind = event.target.value; renderList(); });
    $('#tools-machine').addEventListener('change', (event) => { filters.machine = event.target.value; renderList(); });
    $('#tools-unused').addEventListener('change', (event) => { filters.unused = event.target.checked; renderList(); });
    $('#tools-sort').addEventListener('change', (event) => { filters.sort = event.target.value; renderList(); });
    $('#tools-clear').addEventListener('click', clearFilters);
    $('#prototype-state').addEventListener('change', (event) => setState(event.target.value));
    setState('full');
  } catch {
    renderState('error', start, null, copy);
  }
}
start();
