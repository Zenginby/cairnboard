import '../_shared/theme.js';
import { lessMotion, tokenTime } from '../_shared/components.js';

export function setupShell(search) {
  const bar = document.querySelector('[data-app-tabs]');
  const links = [...bar.querySelectorAll('a')];
  const indicator = bar.querySelector('.tab-indicator');
  let slide;
  let origin;
  try {
    origin = JSON.parse(sessionStorage.getItem('prototype-tab-origin'));
    sessionStorage.removeItem('prototype-tab-origin');
  } catch { /* Navigation still works without storage. */ }
  const position = () => {
    const current = links.find((link) => {
      const url = new URL(link.href);
      return url.pathname === location.pathname && url.hash === location.hash;
    }) || links.find((link) => link.getAttribute('aria-current') === 'page');
    if (!current) return;
    const changed = indicator.parentElement !== current;
    const before = origin || indicator.getBoundingClientRect();
    links.forEach((link) => {
      if (link === current) link.setAttribute('aria-current', new URL(link.href).hash ? 'location' : 'page');
      else link.removeAttribute('aria-current');
    });
    if (changed) current.prepend(indicator);
    if ((changed || origin) && !lessMotion() && Number.isFinite(before.left) && Number.isFinite(before.top)) {
      slide?.cancel();
      const after = indicator.getBoundingClientRect();
      slide = indicator.animate([{ transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` }, { transform: 'none' }], { duration: tokenTime('--motion-duration-fast'), easing: getComputedStyle(document.documentElement).getPropertyValue('--motion-ease-smooth-out').trim() });
      slide.finished.catch(() => {});
    }
    origin = null;
  };
  links.forEach((link) => link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0 || new URL(link.href).pathname === location.pathname) return;
    const rect = indicator.getBoundingClientRect();
    try { sessionStorage.setItem('prototype-tab-origin', JSON.stringify({ left: rect.left, top: rect.top })); } catch { /* Optional continuity across a full page load. */ }
  }));
  document.documentElement.addEventListener('motionchange', () => { if (lessMotion()) slide?.cancel(); });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (lessMotion()) slide?.cancel(); });
  position();
  const header = document.querySelector('.app-shell');
  const brand = header.querySelector('.brand');
  const actions = header.querySelector('.shell-actions');
  const searchButton = header.querySelector('.shell-search');
  const singleRow = matchMedia('(min-width: 80rem)');
  let fullSearchWidth = 0;
  const fit = () => {
    if (!header.classList.contains('is-compact-search')) fullSearchWidth = searchButton.getBoundingClientRect().width;
    const padding = parseFloat(getComputedStyle(header).paddingInlineEnd);
    const gap = parseFloat(getComputedStyle(header.querySelector('.shell-top-row')).gap);
    const navLeft = (innerWidth - bar.getBoundingClientRect().width) / 2;
    const navRight = innerWidth - navLeft;
    const otherActions = actions.getBoundingClientRect().width - searchButton.getBoundingClientRect().width;
    const available = singleRow.matches
      ? innerWidth - padding - navRight - gap - otherActions
      : innerWidth - padding * 2 - brand.getBoundingClientRect().width - gap - otherActions;
    header.classList.toggle('is-compact-search', available < fullSearchWidth);
    const actionsLeft = innerWidth - padding - otherActions - searchButton.getBoundingClientRect().width;
    header.classList.toggle('is-stacked-nav', singleRow.matches
      && (navLeft < brand.getBoundingClientRect().right + gap || navRight + gap > actionsLeft));
    position();
  };
  new ResizeObserver(fit).observe(header);
  new ResizeObserver(fit).observe(bar);
  singleRow.addEventListener('change', fit);
  fit();
  addEventListener('hashchange', position);
  const trigger = document.querySelector('#theme-open');
  const panel = document.querySelector('#theme-panel');
  const close = (restore = false) => {
    panel.classList.remove('is-open');
    panel.inert = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restore) trigger.focus();
  };
  trigger.addEventListener('click', (event) => {
    if (panel.classList.contains('is-open')) { close(true); return; }
    panel.classList.toggle('is-instant', event.detail === 0);
    panel.inert = false;
    panel.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    panel.querySelector('select').focus({ preventScroll: true });
  });
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } });
  panel.addEventListener('focusout', (event) => { if (!panel.contains(event.relatedTarget) && event.relatedTarget !== trigger) close(); });
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.theme-dropdown')) close(); });
  document.querySelector('#search-open').addEventListener('click', (event) => { close(); search(event.detail === 0); });
}
