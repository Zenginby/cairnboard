// On narrow screens the tab row scrolls sideways; bring the current tab into view without moving the page.
const tabs = document.querySelector('.app-tabs');
const current = tabs?.querySelector('[aria-current="page"]');
if (tabs && current && tabs.scrollWidth > tabs.clientWidth) {
  tabs.scrollLeft = current.offsetLeft - (tabs.clientWidth - current.offsetWidth) / 2;
}
