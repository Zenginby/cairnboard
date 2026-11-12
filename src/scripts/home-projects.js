// A Home project box opens its details as a layer over its cover. The close button and Escape shut the layer and
// put focus back on the box's summary; without this script a box still closes when another one opens.
function close(box) {
  box.open = false;
  box.querySelector(':scope > summary')?.focus({ preventScroll: true });
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-project-close]') : null;
  const box = button?.closest('details.project-collapsible');
  if (box) close(box);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const box = event.target instanceof Element ? event.target.closest('details.project-collapsible[open]') : null;
  if (!box) return;
  event.preventDefault();
  close(box);
});
