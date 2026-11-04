import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, loadData, setupUI, renderState } from '../_shared/app-ui.js';

// 500: never shows a path, a file name or a stack trace; only a short reference the user can pass on.
let ui;
let timer;
const easing = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const texts = {
  normal: 'Sunucu bu isteği tamamlayamadı. Hiçbir dosya değişmedi; yeniden deneyebilir ya da Ana sayfaya dönebilirsin.',
  long: 'Sunucu bu isteği tamamlayamadı. Hiçbir dosya değişmedi ve yarım kalan bir yazma yok; açık olan notların ve kartların olduğu gibi duruyor. Biraz bekleyip yeniden deneyebilir, Ana sayfaya dönebilir ya da sorun sürerse cairn doctor komutuyla kurulumu denetleyebilirsin.',
  failed: 'Hâlâ olmadı. Hiçbir dosya değişmedi. Biraz bekleyip yeniden dene; sorun sürerse cairn doctor komutunu çalıştır.',
};

function busy(on) {
  const retry = $('#status-retry');
  retry.setAttribute('aria-busy', String(on));
  retry.disabled = on;
  retry.replaceChildren();
  if (on) {
    const spinner = el('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    retry.append(spinner, 'Yeniden deneniyor…');
  } else retry.append('Yeniden dene');
}
function setState(value) {
  clearTimeout(timer);
  $('#prototype-state').value = value;
  renderState('full', null, null);
  busy(value === 'loading');
  $('#status-text').textContent = value === 'error' ? texts.failed : value === 'long' ? texts.long : texts.normal;
  $('#status-ref').textContent = value === 'empty' ? '' : 'Başvuru kodu: E-7F3A · 3 Kasım 17.15';
}
function retry() {
  busy(true);
  $('#announcements').textContent = 'Yeniden deneniyor.';
  timer = setTimeout(() => {
    setState('error');
    $('#announcements').textContent = texts.failed;
    $('#status-retry').focus();
  }, tokenTime('--motion-duration-highlight'));
}
async function start() {
  let data;
  try { data = await loadData('../_shared/workspace.json'); } catch { data = { cards: [], notes: [], journal: [], projects: [], people: [], columns: [] }; }
  ui = setupUI(data, () => {}, (instant) => ui.create('card', instant));
  $('#status-retry').addEventListener('click', retry);
  $('#prototype-state').addEventListener('change', (event) => setState(event.target.value));
  setState('full');
  const less = lessMotion();
  $('.status-card').animate(less ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(var(--motion-distance-base))' }, { opacity: 1, transform: 'none' }], { duration: tokenTime(less ? '--motion-duration-quick' : '--motion-duration-fast'), easing: easing('--motion-ease-spring'), fill: 'backwards' });
}
start();
