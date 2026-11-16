// One short status line at the bottom of the screen ("Note saved. Open note"), outside every dialog.
let timer = null;

/**
 * @param {string} text
 * @param {{ href?: string, label?: string }} [link]
 */
export function toast(text, link = {}) {
  const node = document.querySelector('[data-app-toast]');
  if (!node) return;
  clearTimeout(timer);
  node.replaceChildren(document.createTextNode(text));
  if (link.href && link.label) {
    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.textContent = link.label;
    node.append(' ', anchor);
  }
  node.hidden = false;
  const hide = () => {
    // A pointer on the toast or focus on its link keeps it up until it leaves.
    if (node.matches(':hover, :focus-within')) { timer = setTimeout(hide, 1500); return; }
    node.hidden = true;
    node.replaceChildren();
  };
  timer = setTimeout(hide, 6000);
}
