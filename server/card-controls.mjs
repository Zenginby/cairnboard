// Turns the Acceptance checkboxes of a rendered card into submit buttons for the page's check forms.
// The renderer marks each such checkbox with its item number (`data-acceptance`); other task boxes stay read-only.
//
// `<input type="checkbox"` with literal quotes occurs only where a real tag starts: serialized text escapes `<`
// and attribute values escape `"`. From a real tag start the quotes pair up, so the match ends at that tag's `>`.
const INPUT = /<input type="checkbox"(?:[^">]|"[^"]*")*>/gu;

/**
 * @param {string | null | undefined} html sanitized HTML from the renderer
 * @param {Array<{ checked: boolean }>} items the card's Acceptance items, in order
 * @returns {{ html: string | null | undefined, wired: Set<number> }} `wired` holds the item numbers that got a button
 */
export function cardControls(html, items) {
  const wired = new Set();
  if (html == null || !items.length) return { html, wired };
  const changed = html.replace(INPUT, (input) => {
    const n = Number(input.match(/ data-acceptance="([1-9][0-9]{0,5})"/u)?.[1]);
    // A button needs a name; an item without text keeps its plain box and gets a labelled button below the body.
    const label = input.match(/ aria-label="[^"]+"/u)?.[0];
    const item = items[n - 1];
    if (!item || !label || wired.has(n)) return input;
    wired.add(n);
    return `<button class="card-check" type="submit" form="card-check-${n}" role="checkbox" `
      + `aria-checked="${item.checked === true}"${label}><span aria-hidden="true">${item.checked ? '☑' : '☐'}</span>`
      + '</button>';
  });
  return { html: changed, wired };
}
