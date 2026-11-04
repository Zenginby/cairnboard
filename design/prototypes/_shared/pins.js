// Pinned notes shared by every page in this browser session: the note page's Sabitle button, the pinned rail and the
// "Sabitlenenler" sidebar group all read and write here, so pinning anywhere shows everywhere at once.
const key = 'prototype-pins';

export function readPins() {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || '{}');
    return { added: Array.isArray(value.added) ? value.added : [], removed: Array.isArray(value.removed) ? value.removed : [] };
  } catch { return { added: [], removed: [] }; }
}
function save(pins, source) {
  try { sessionStorage.setItem(key, JSON.stringify(pins)); } catch { /* Still works on this page. */ }
  document.dispatchEvent(new CustomEvent('pinchange', { detail: { source } }));
}
// note: { id, kind, title, projectId, updated, body, project?: { name, tone } }
export function pinNote(note, source = '') {
  const pins = readPins();
  pins.removed = pins.removed.filter((id) => id !== note.id);
  if (!pins.added.some((item) => item.id === note.id)) pins.added.unshift(note);
  save(pins, source);
}
export function unpinNote(id, source = '') {
  const pins = readPins();
  pins.added = pins.added.filter((item) => item.id !== id);
  if (!pins.removed.includes(id)) pins.removed.push(id);
  save(pins, source);
}
// `fallback` is what the page's own data says when this session has not changed the note.
export function isPinned(id, fallback = false) {
  const pins = readPins();
  if (pins.added.some((item) => item.id === id)) return true;
  if (pins.removed.includes(id)) return false;
  return fallback;
}
