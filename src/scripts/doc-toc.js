// "On this page" behaviour for [data-doc-toc] panels: marks the heading being read with aria-current,
// scrolls smoothly on click and keeps the URL hash in sync without a jump. The scrolling element is the
// window unless the panel names one with data-doc-toc-root="<css selector>" (for example a dialog body).
// Without this script the panel links still work as plain anchors.

const WIDE = '(min-width: 64rem)';
const bound = new Map();

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    || Boolean(document.querySelector('[data-motion="less"]'));
}

function targetId(link) {
  const href = link.getAttribute('href') || '';
  if (!href.startsWith('#') || href.length < 2) return null;
  try { return decodeURIComponent(href.slice(1)); } catch { return href.slice(1); }
}

function findHeading(scope, id) {
  const owner = scope instanceof Document ? scope : scope.ownerDocument;
  const found = owner.getElementById(id);
  if (found && (scope instanceof Document || scope.contains(found))) return found;
  return null;
}

function setCurrent(links, active) {
  for (const link of links) {
    if (link === active) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

function bind(panel) {
  const selector = panel.getAttribute('data-doc-toc-root');
  let root = null;
  if (selector) {
    try { root = document.querySelector(selector); } catch { root = null; }
  }
  const scope = root || document;
  const links = [...panel.querySelectorAll('a[href^="#"]')];
  const entries = links
    .map((link) => ({ link, heading: findHeading(scope, targetId(link) ?? '') }))
    .filter((entry) => entry.heading);
  const cleanups = [];

  // Wide screens show the panel as an open side column; narrow screens keep it as a closed disclosure.
  const details = panel.querySelector('[data-doc-toc-details]');
  const media = window.matchMedia?.(WIDE);
  if (details && media) {
    const sync = () => { details.open = media.matches; };
    sync();
    media.addEventListener?.('change', sync);
    cleanups.push(() => media.removeEventListener?.('change', sync));
  }

  const onClick = (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link || event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const entry = entries.find((item) => item.link === link);
    if (!entry) return;
    event.preventDefault();
    entry.heading.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    if (!root) history.replaceState(history.state, '', `#${encodeURIComponent(entry.heading.id)}`);
    setCurrent(links, link);
    if (details && media && !media.matches) details.open = false;
  };
  panel.addEventListener('click', onClick);
  cleanups.push(() => panel.removeEventListener('click', onClick));

  if (entries.length && typeof IntersectionObserver === 'function') {
    const visible = new Set();
    const pick = () => {
      // The first heading inside the reading band wins; otherwise the last heading above it.
      const inBand = entries.find((entry) => visible.has(entry.heading));
      if (inBand) return setCurrent(links, inBand.link);
      const top = root ? root.getBoundingClientRect().top : 0;
      let last = null;
      for (const entry of entries) {
        if (entry.heading.getBoundingClientRect().top - top <= 0) last = entry;
      }
      setCurrent(links, last?.link ?? null);
    };
    const observer = new IntersectionObserver((records) => {
      for (const record of records) {
        if (record.isIntersecting) visible.add(record.target);
        else visible.delete(record.target);
      }
      pick();
    }, { root, rootMargin: '0px 0px -65% 0px', threshold: 0 });
    for (const entry of entries) observer.observe(entry.heading);
    cleanups.push(() => observer.disconnect());
  }

  return () => { for (const cleanup of cleanups) cleanup(); };
}

/** Binds every [data-doc-toc] panel inside rootElement (default: document); safe to call again after a swap. */
export function initDocToc(rootElement = document) {
  for (const [panel, cleanup] of bound) {
    if (!panel.isConnected) { cleanup(); bound.delete(panel); }
  }
  const panels = rootElement.matches?.('[data-doc-toc]') ? [rootElement] : [];
  panels.push(...rootElement.querySelectorAll('[data-doc-toc]'));
  for (const panel of panels) {
    bound.get(panel)?.();
    bound.set(panel, bind(panel));
  }
}

if (typeof document !== 'undefined') {
  initDocToc(document);
  document.addEventListener('live:updated', () => initDocToc(document));
}
