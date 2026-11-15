// Per-owner live-update pause state; keeps data-live-paused="true" while any owner holds a pause.
// The owner list only counts while the flag is set: a flag cleared from outside drops every recorded owner.
const owners = (root) => new Set(root.dataset.livePaused === 'true'
  ? (root.dataset.livePausedBy || '').split(/\s+/u).filter(Boolean) : []);

export function pauseLive(owner, doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root || !owner) return;
  const set = owners(root);
  if (!set.size && root.dataset.livePaused === 'true') set.add('external');
  set.add(owner);
  root.dataset.livePausedBy = [...set].join(' ');
  root.dataset.livePaused = 'true';
}

export function resumeLive(owner, doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root || !owner) return;
  const set = owners(root);
  if (!set.delete(owner)) {
    if (!set.size) delete root.dataset.livePausedBy;
    return;
  }
  if (set.size > 0) {
    root.dataset.livePausedBy = [...set].join(' ');
    root.dataset.livePaused = 'true';
    return;
  }
  delete root.dataset.livePausedBy;
  delete root.dataset.livePaused;
  doc.dispatchEvent?.(new CustomEvent('live:resume'));
}
