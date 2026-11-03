import '../_shared/theme.js';

export function setupShell(search) {
  const bar = document.querySelector('[data-app-tabs]');
  const links = [...bar.querySelectorAll('a')];
  const indicator = bar.querySelector('.tab-indicator');
  const position = () => {
    const current = links.find((link) => {
      const url = new URL(link.href);
      return url.pathname === location.pathname && url.hash === location.hash;
    }) || links.find((link) => link.getAttribute('aria-current') === 'page');
    if (!current) return;
    links.forEach((link) => {
      if (link === current) link.setAttribute('aria-current', new URL(link.href).hash ? 'location' : 'page');
      else link.removeAttribute('aria-current');
    });
    for (const [name, value] of Object.entries({ width: current.offsetWidth, height: current.offsetHeight, x: current.offsetLeft, y: current.offsetTop })) indicator.style.setProperty(`--indicator-${name}`, `${value}px`);
  };
  indicator.classList.add('is-instant');
  position();
  requestAnimationFrame(() => indicator.classList.remove('is-instant'));
  new ResizeObserver(position).observe(bar);
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
  const updateIcon = () => {
    const theme = document.documentElement.dataset.theme;
    trigger.classList.toggle('is-dark', ['bento-dark', 'graphite'].includes(theme) || (!theme && matchMedia('(prefers-color-scheme: dark)').matches));
  };
  updateIcon();
  document.documentElement.addEventListener('themechange', updateIcon);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateIcon);
  document.querySelector('#search-open').addEventListener('click', (event) => { close(); search(event.detail === 0); });
}
