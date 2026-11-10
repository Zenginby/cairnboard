// Only Acceptance items recognised by the core become writes; other Markdown tasks remain read-only.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { acceptanceItems } from '../core/frontmatter.mjs';

const parser = unified().use(remarkParse).use(remarkGfm);
export function cardControls(html, body) {
  if (html == null) return html;
  const items = acceptanceItems(body);
  if (!items.length) return html;
  const numbers = new Map(items.map((item, index) => [item.line, index]));
  const tasks = [];
  function walk(node) {
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      tasks.push(numbers.get(node.position.start.line) ?? -1);
    }
    for (const child of node.children ?? []) walk(child);
  }
  try { walk(parser.parse(body)); } catch (error) {
    if (error instanceof RangeError) return html;
    throw error;
  }
  const inputs = /<input\b(?:[^">]|"[^"]*")*>/gu;
  // Fail closed if a renderer change ever changes the correspondence with Markdown's task nodes.
  if ([...html.matchAll(inputs)].length !== tasks.length) return html;
  let index = 0;
  return html.replace(inputs, (input) => {
    const n = tasks[index++] + 1;
    if (!n) return input;
    const label = input.match(/aria-label="[^"]*"/u)?.[0];
    if (!label) return input;
    const checked = items[n - 1].checked;
    return `<button class="card-check" type="submit" form="card-check-${n}" role="checkbox" `
      + `aria-checked="${checked}" ${label}><span aria-hidden="true">${checked ? '☑' : '☐'}</span></button>`;
  });
}
