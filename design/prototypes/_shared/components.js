// Shared behavior for prototypes. Call once after adding component markup.
export const lessMotion = () => document.documentElement.dataset.motion === 'less'
  || matchMedia('(prefers-reduced-motion: reduce)').matches;

export function tokenTime(name, element = document.documentElement) {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
}

export function initComponents(scope = document) {
  // A sticky bar can wrap; keep focus and anchor clearance equal to its actual height.
  const header = scope.querySelector('.topbar');
  if (header) new ResizeObserver(() => document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`)).observe(header);
  scope.querySelectorAll('.dropdown').forEach((dropdown) => {
    const trigger = dropdown.querySelector('[aria-haspopup="menu"]');
    const menu = dropdown.querySelector('.menu');
    if (!trigger || !menu) return;
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const close = (restore = false) => {
      menu.classList.remove('is-open');
      menu.inert = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restore) trigger.focus();
    };
    const open = (instant = false, last = false) => {
      menu.classList.toggle('is-instant', instant);
      menu.classList.add('is-open');
      menu.inert = false;
      trigger.setAttribute('aria-expanded', 'true');
      (last ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    };
    close();
    trigger.addEventListener('click', (event) => {
      if (menu.classList.contains('is-open')) close(true);
      else open(event.detail === 0);
    });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        open(true, event.key === 'ArrowUp');
      }
    });
    menu.addEventListener('keydown', (event) => {
      const index = items.indexOf(document.activeElement);
      const positions = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 };
      if (event.key in positions) {
        event.preventDefault();
        items[positions[event.key]].focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'Tab') close(true);
    });
    menu.addEventListener('click', (event) => {
      if (event.target.closest('[role="menuitem"]')) close(true);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!dropdown.contains(event.target)) close();
    });
    dropdown.addEventListener('focusout', (event) => {
      if (!dropdown.contains(event.relatedTarget)) close();
    });
  });

  scope.querySelectorAll('[role="tablist"]').forEach((bar) => {
    const tabs = [...bar.querySelectorAll('[role="tab"]:not(:disabled)')];
    const indicator = bar.querySelector('.tab-indicator');
    const position = () => {
      const tab = tabs.find((item) => item.getAttribute('aria-selected') === 'true');
      if (!tab || !indicator) return;
      indicator.style.setProperty('--indicator-width', `${tab.offsetWidth}px`);
      indicator.style.setProperty('--indicator-height', `${tab.offsetHeight}px`);
      indicator.style.setProperty('--indicator-x', `${tab.offsetLeft}px`);
      indicator.style.setProperty('--indicator-y', `${tab.offsetTop}px`);
    };
    const select = (tab) => {
      tabs.forEach((item) => {
        const selected = item === tab;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(item.getAttribute('aria-controls'));
        if (panel) panel.hidden = !selected;
      });
      position();
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => select(tab)));
    bar.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(document.activeElement);
      const positions = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!(event.key in positions)) return;
      event.preventDefault();
      const tab = tabs[positions[event.key]];
      tab.focus();
      select(tab);
    });
    new ResizeObserver(position).observe(bar);
    position();
  });
}

export function showDialog(dialog, instant = false) {
  dialog.classList.toggle('is-instant', instant);
  if (!dialog.open) dialog.showModal();
}

// FLIP uses the current visual position, so a second move can interrupt a settle.
export function moveCard(card, destination, liveRegion) {
  const cards = [...card.closest('[data-board]').querySelectorAll('.kanban-card')];
  const first = new Map(cards.map((item) => [item, item.getBoundingClientRect()]));
  cards.forEach((item) => item.classList.add('is-instant'));
  destination.append(card);
  card.querySelector('[data-card-status]').textContent = destination.dataset.label;
  card.querySelector('[data-card-status]').className = `chip chip--${destination.dataset.status}`;
  cards.forEach((item) => {
    item.style.transform = 'none';
    const last = item.getBoundingClientRect();
    const previous = first.get(item);
    if (!lessMotion()) item.style.transform = `translate(${previous.left - last.left}px, ${previous.top - last.top}px)`;
  });
  void card.offsetWidth;
  cards.forEach((item) => {
    item.classList.remove('is-instant');
    item.style.transform = '';
  });
  card.querySelector('[data-move-trigger]')?.focus({ preventScroll: true });
  liveRegion.textContent = `${card.querySelector('h3').textContent} → ${destination.dataset.label}.`;
  cancelAnimationFrame(card.highlightFrame);
  card.classList.remove('is-highlighted');
  card.settleTimer && clearTimeout(card.settleTimer);
  card.settleTimer = setTimeout(() => {
    card.classList.add('is-highlighted');
    void card.offsetWidth;
    card.highlightFrame = requestAnimationFrame(() => card.classList.remove('is-highlighted'));
  }, tokenTime(lessMotion() ? '--motion-duration-quick' : '--motion-duration-fast'));
}
