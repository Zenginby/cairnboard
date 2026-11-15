// Editable elements keep keyboard shortcuts such as `/` and `N` while the owner is typing.
export const typing = (target) => target instanceof Element
  && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
