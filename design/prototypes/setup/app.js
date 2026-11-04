import { initComponents, lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, button, renderState } from '../_shared/app-ui.js';

// İlk açılış: four steps in one centred card. The folder check stands in for the server's answer.
const steps = ['Hoş geldin', 'Veri klasörü', 'Örnek veri', 'Hazır'];
const defaults = { path: '~/Belgeler/cairn', language: 'tr', sample: true };
const longPath = '~/Belgeler/calisma-alanlari/cok-uzun-bir-klasor-adi-ile-acilan-ornek-calisma-alani/notlar-ve-kartlar/cairn';
let state = 'full';
let step = 0;
let answers = { ...defaults };
let check = { status: 'idle' };
let checkTimer;
const copy = {
  loading: ['Kurulum hazırlanıyor', 'Yerel sunucu başlıyor; birkaç saniye sürebilir.'],
  error: ['Yerel sunucuya ulaşılamadı', 'cairn serve çalışıyor mu bak, sonra yeniden dene. Hiçbir dosya oluşturulmadı.'],
};
const easing = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const announce = (text) => { $('#announcements').textContent = text; };

// Simulated server answers: "izin" or a system folder → no permission; "yeni" or "yok" → missing; otherwise valid.
function serverCheck(path) {
  const value = path.trim();
  if (!value) return { status: 'invalid', text: 'Bir klasör yolu yaz.' };
  if (/izin|^\/(sistem|system|root)\b/i.test(value)) return { status: 'denied', text: 'Bu klasöre yazma izni yok. Kendi ev klasöründe bir yer seç.' };
  if (/yeni|yok/i.test(value)) return { status: 'missing', text: 'Bu klasör yok.' };
  return { status: 'valid', text: 'Geçerli: klasör boş ve yazılabilir.' };
}
function runCheck(after) {
  clearTimeout(checkTimer);
  check = { status: 'checking' };
  paintCheck();
  checkTimer = setTimeout(() => {
    check = serverCheck(answers.path);
    paintCheck();
    announce(check.status === 'missing' ? 'Bu klasör yok. Oluşturulsun mu?' : check.text);
    after?.();
  }, tokenTime('--motion-duration-very-slow'));
}
function paintCheck() {
  const line = $('#path-status');
  const next = $('#step-next');
  if (!line) return;
  const input = $('#path-input');
  input.setAttribute('aria-invalid', String(['denied', 'invalid'].includes(check.status)));
  line.replaceChildren();
  line.dataset.status = check.status;
  if (check.status === 'checking') {
    const spinner = el('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    line.append(spinner, el('span', 'muted', 'Klasör denetleniyor…'));
  } else if (check.status === 'valid') line.append(el('span', 'chip chip--done', 'Geçerli'), el('span', '', check.text.replace('Geçerli: ', '')));
  else if (check.status === 'missing') {
    line.append(el('span', 'chip chip--warning', 'Yok'), el('span', '', 'Bu klasör yok. Oluşturulsun mu?'));
    const create = button('Oluştur', () => {
      create.setAttribute('aria-busy', 'true');
      create.disabled = true;
      setTimeout(() => {
        check = { status: 'valid', text: 'Geçerli: klasör oluşturuldu ve yazılabilir.' };
        paintCheck();
        announce('Klasör oluşturuldu.');
        $('#step-next').focus();
      }, tokenTime('--motion-duration-slow'));
    }, 'button path-create');
    line.append(create);
  } else if (check.status === 'denied') line.append(el('span', 'chip chip--danger', 'İzin yok'), el('span', '', check.text));
  else if (check.status === 'invalid') line.append(el('span', 'chip chip--danger', 'Eksik'), el('span', '', check.text));
  else line.append(el('span', 'muted', 'Devam etmeden önce klasör denetlenir.'));
  if (next) next.disabled = check.status !== 'valid';
}
function segmented(name, choices, current, onChange) {
  const wrap = el('div', 'segmented');
  wrap.setAttribute('role', 'radiogroup');
  choices.forEach(([value, label]) => {
    const option = el('label', 'segmented-option');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = value === current;
    input.addEventListener('change', () => onChange(value));
    option.append(input, el('span', '', label));
    wrap.append(option);
  });
  return wrap;
}
function stepList() {
  $('#setup-steps').replaceChildren(...steps.map((label, index) => {
    const item = el('li', `setup-step${index < step ? ' is-done' : ''}${index === step ? ' is-current' : ''}`);
    if (index === step) item.setAttribute('aria-current', 'step');
    const mark = el('span', 'setup-step-mark', index < step ? '✓' : String(index + 1));
    mark.setAttribute('aria-hidden', 'true');
    item.append(mark, el('span', 'setup-step-label', label), el('span', 'sr-only', index < step ? ' (tamam)' : ''));
    return item;
  }));
}
function actions(primaryLabel, onPrimary, back = true) {
  const row = el('div', 'setup-actions');
  if (back) row.append(button('Geri', () => go(step - 1), 'button button--quiet'));
  const next = button(primaryLabel, onPrimary, 'button button--primary setup-next');
  next.id = 'step-next';
  row.append(next);
  return row;
}
function heading(text, lead) {
  const title = el('h1', 'setup-title', text);
  title.id = 'step-title';
  title.tabIndex = -1;
  const nodes = [el('p', 'setup-eyebrow', `Adım ${step + 1} / ${steps.length}`), title];
  if (lead) nodes.push(el('p', 'setup-lead', lead));
  return nodes;
}
function welcome() {
  const language = el('div', 'setup-field');
  const label = el('p', 'setup-label', 'Dil');
  label.id = 'language-label';
  const control = segmented('setup-language', [['tr', 'Türkçe'], ['en', 'English']], answers.language, (value) => { answers.language = value; announce(value === 'en' ? 'English seçildi. Arayüz kurulumdan sonra İngilizce olur.' : 'Türkçe seçildi.'); });
  control.setAttribute('aria-labelledby', label.id);
  language.append(label, control);
  return [...heading('Cairnboard’a hoş geldin', state === 'long' ? 'Notların, kartların ve günlüğün bilgisayarında, düz Markdown dosyalarında durur. Sen ve ajanların aynı klasörde çalışırsınız; hiçbir şey buluta gönderilmez ve hiçbir dosya senden habersiz silinmez. Kurulum dört kısa adımdan oluşur ve istediğin zaman geri dönebilirsin.' : 'Notların, kartların ve günlüğün bilgisayarında, düz Markdown dosyalarında durur. Birkaç kısa adımda hazır.'), language, actions('Başla', () => go(1), false)];
}
function folder() {
  const fieldNode = el('div', 'setup-field');
  const label = el('label', 'setup-label', 'Veri klasörü');
  label.htmlFor = 'path-input';
  const row = el('div', 'path-row');
  const input = el('input', 'input path-input');
  input.id = 'path-input';
  input.value = answers.path;
  input.placeholder = '~/Belgeler/cairn';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-describedby', 'path-status path-hint');
  input.addEventListener('input', () => { answers.path = input.value; clearTimeout(checkTimer); check = { status: 'idle' }; paintCheck(); });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); runCheck(); } });
  input.addEventListener('change', () => runCheck());
  row.append(input, button('Denetle', () => runCheck(), 'button path-check'));
  const status = el('p', 'path-status');
  status.id = 'path-status';
  status.setAttribute('aria-live', 'polite');
  const hint = el('p', 'setup-hint');
  hint.id = 'path-hint';
  hint.append('Prototipte dene: ', el('code', '', '~/Belgeler/cairn'), ' geçerli, ', el('code', '', '~/Belgeler/yeni-cairn'), ' yok, ', el('code', '', '/sistem/cairn'), ' izin yok.');
  fieldNode.append(label, row, status, hint);
  return [...heading('Veri klasörünü seç', 'Her şey bu klasörde düz dosyalar olarak durur. Sonradan cairn init ile değiştirebilirsin.'), fieldNode, actions('Devam', () => { if (check.status === 'valid') go(2); })];
}
function sample() {
  const option = el('label', 'sample-option');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = answers.sample;
  input.addEventListener('change', () => { answers.sample = input.checked; });
  const text = el('span', 'sample-copy');
  text.append(el('span', 'sample-title', 'Örnek veri ekle'), el('span', 'sample-text', 'Bir örnek proje, üç not ve beş kart. Neyin nerede durduğunu görmek için; sonra tek tıkla Çöp’e gider.'));
  option.append(input, text);
  return [...heading('Örnek veriyle başla', 'İsteğe bağlı. Boş bir çalışma alanıyla da başlayabilirsin.'), option, actions('Devam', () => go(3))];
}
function done() {
  const list = el('dl', 'setup-summary');
  [['Dil', answers.language === 'en' ? 'English' : 'Türkçe'], ['Klasör', answers.path], ['Örnek veri', answers.sample ? 'Eklendi' : 'Eklenmedi']].forEach(([term, value]) => {
    const row = el('div', 'setup-summary-row');
    row.append(el('dt', '', term), el('dd', term === 'Klasör' ? 'type-code' : '', value));
    list.append(row);
  });
  const row = el('div', 'setup-actions');
  row.append(button('Geri', () => go(2), 'button button--quiet'));
  const home = el('a', 'button button--primary setup-next', 'Ana sayfaya git');
  home.href = '../home/';
  home.id = 'step-next';
  row.append(home);
  return [...heading('Hazırsın', 'Çalışma alanı kuruldu. Ajanlarına bu klasörü göstermek için cairn agents install komutunu kullanabilirsin.'), list, row];
}
function paint() {
  stepList();
  const card = $('#setup-card');
  card.replaceChildren(...[welcome, folder, sample, done][step]());
  if (step === 1) {
    paintCheck();
    if (check.status === 'idle' && answers.path) runCheck();
  }
  initComponents(card);
}
function go(next, focus = true) {
  if (next < 0 || next >= steps.length) return;
  const forward = next > step;
  step = next;
  paint();
  const card = $('#setup-card');
  const less = lessMotion();
  card.animate(less ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateX(calc(${forward ? 1 : -1} * var(--motion-distance-medium)))` }, { opacity: 1, transform: 'none' }], { duration: tokenTime(less ? '--motion-duration-quick' : '--motion-duration-fast'), easing: easing('--motion-ease-smooth-out') });
  if (focus) $('#step-title').focus({ preventScroll: true });
  announce(`Adım ${step + 1} / ${steps.length}: ${steps[step]}.`);
}
function setState(value) {
  state = value;
  clearTimeout(checkTimer);
  $('#prototype-state').value = value;
  answers = { ...defaults };
  check = { status: 'idle' };
  renderState(['loading', 'error'].includes(value) ? value : 'full', () => setState('full'), null, copy);
  if (['loading', 'error'].includes(value)) return;
  step = 0;
  if (value === 'empty') { answers.path = ''; step = 1; }
  if (value === 'missing') { answers.path = '~/Belgeler/yeni-cairn'; step = 1; }
  if (value === 'denied') { answers.path = '/sistem/cairn'; step = 1; }
  if (value === 'long') answers.path = longPath;
  paint();
}
$('#prototype-state').addEventListener('change', (event) => setState(event.target.value));
initComponents();
setState('full');
