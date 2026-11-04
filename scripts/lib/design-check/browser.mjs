// These functions run in the page through evaluate/addInitScript, without changing its CSP or source.
export function initializePage({ family, mode }) {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
  });
  if (location.protocol === 'http:') {
    localStorage.setItem('prototype-theme', family);
    localStorage.setItem('prototype-mode', mode);
    localStorage.setItem('prototype-pinned-rail', 'open');
  }
  // Sample from the first frame so short entry animations and hover transitions cannot disappear before inspection.
  window.__motionViolations = new Set();
  const movement = new Set(['transform', 'translate', 'scale', 'rotate', 'grid-template-rows', 'background-size', 'stroke-dashoffset', 'clip-path', 'filter']);
  const sample = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const animation of document.getAnimations()) {
        if (animation.playState !== 'running' || !animation.effect?.getKeyframes) continue;
        const frames = animation.effect.getKeyframes();
        const properties = new Set(frames.flatMap((frame) => Object.keys(frame)));
        for (const property of properties) {
          const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          if (!movement.has(cssName)) continue;
          if (frames.length > 1 && new Set(frames.map((frame) => frame[property])).size < 2) continue;
          const target = animation.effect.target;
          const label = target?.tagName ? `${target.tagName.toLowerCase()}.${[...target.classList].join('.')}` : 'unknown';
          window.__motionViolations.add(`${label}: running ${cssName} animation`);
        }
      }
    }
    window.__motionFrame = requestAnimationFrame(sample);
  };
  window.__motionFrame = requestAnimationFrame(sample);
}

export function inspectLayout() {
  const label = (element) => [element.tagName.toLowerCase(), ...element.classList].join('.');
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const overflow = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) {
    const widest = [...document.body.querySelectorAll('*')].filter(visible)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > innerWidth + 1 || rect.left < -1)
      .sort((a, b) => b.rect.width - a.rect.width).slice(0, 3)
      .map(({ element, rect }) => `${label(element)} (${Math.round(rect.width)}px)`);
    overflow.push({ message: `scrollWidth ${document.documentElement.scrollWidth} > viewport ${innerWidth}; widest: ${widest.join(', ') || 'none'}` });
  }
  const overlap = [];
  const rail = document.querySelector('.pinned-rail');
  if (document.documentElement.dataset.pinnedRail === 'open' && rail && visible(rail)) {
    const box = rail.getBoundingClientRect();
    // Inspect descendants, not main's outer box: grids and document frames can span empty space beside content.
    for (const element of document.querySelectorAll('main *')) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top) {
        overlap.push({ message: `${label(element)} intersects .pinned-rail` });
      }
    }
  }
  return { overflow, overlap };
}

export function rememberFocusStyles() {
  // Record the unfocused style even on pages with autofocus controls.
  document.activeElement?.blur();
  window.__unfocusedShadows = new WeakMap();
  for (const element of document.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable]')) {
    if (element !== document.activeElement) window.__unfocusedShadows.set(element, getComputedStyle(element).boxShadow);
  }
}

export async function inspectFocus() {
  const element = document.activeElement;
  // Browsers pass through the document between the last and first Tab stops.
  if (!element || element === document.body || element === document.documentElement) return [];
  // Allow native focus scrolling (including smooth scroll) to finish, bounded to half a second.
  const start = performance.now();
  let previous;
  let stable = 0;
  do {
    await new Promise(requestAnimationFrame);
    const rect = element.getBoundingClientRect();
    const position = `${rect.x},${rect.y}`;
    stable = position === previous ? stable + 1 : 0;
    previous = position;
  } while (stable < 2 && performance.now() - start < 500);
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const label = [element.tagName.toLowerCase(), ...element.classList].join('.');
  const failures = [];
  let hidden = false;
  for (let node = element; node; node = node.parentElement) {
    if (Number(getComputedStyle(node).opacity) === 0) hidden = true;
  }
  if (!rect.width || !rect.height || rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1 || style.visibility === 'hidden' || hidden) {
    failures.push({ message: `${label}: focused element is hidden or outside the viewport` });
  }
  const transparent = (color) => color === 'transparent' || /[,/]\s*0\s*\)$/.test(color);
  const outline = !['none', 'hidden'].includes(style.outlineStyle) && parseFloat(style.outlineWidth) > 0 && !transparent(style.outlineColor);
  const baseline = window.__unfocusedShadows.get(element);
  const shadow = baseline !== undefined && style.boxShadow !== 'none' && style.boxShadow !== baseline;
  if (!outline && !shadow) failures.push({ message: `${label}: no visible focus outline or changed box-shadow` });
  return failures;
}
