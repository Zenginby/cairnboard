export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const pick = (r, values) => values[Math.floor(r() * values.length)];

export function genDocument(r) {
  const eol = pick(r, ['\n', '\r\n']);
  const mixed = r() < 0.3;
  const title = pick(r, ['Örnek', 'Örnek'.normalize('NFD'), '🪨 acme']);
  const lines = [
    '---',
    '# Keep this header',
    `title: "${title}" # title comment`,
    'unknown: "a: b" # keep this',
    'x-extra: 7',
    'x-stable: "keep this value"',
    'tags:',
    '  - acme',
    '  # inside the old block',
    '  - zorblax',
    'description: |',
    '  first line',
    '  second line',
    'empty:',
    '---',
    `# ${title}`,
    '',
    '## Acceptance',
    '- [ ] first item',
    '```md',
    '## Comments',
    '- [ ] hidden item',
    '```',
    '- [x] second item',
    '~~~',
    '- [ ] another hidden item',
    '~~~',
    '',
    '## Comments',
    'Keep the body.',
  ];
  return (r() < 0.5 ? '\uFEFF' : '') + lines.map((line, i) => {
    if (i === lines.length - 1) return line + (r() < 0.5 ? '' : eol);
    return line + (mixed && i > 0 && r() < 0.3 ? (eol === '\n' ? '\r\n' : '\n') : eol);
  }).join('');
}

export function genOps(r, n) {
  const keys = ['title', 'unknown', 'x-extra', 'tags', 'description', 'empty', 'x-new'];
  const values = ['acme', 'a: b', 'a\nb', 'Örnek'.normalize('NFD'), ['acme', 'zorblax'],
    { nested: ['a\nb', 'c'] }, 7, false, null, undefined];
  return Array.from({ length: n }, () => {
    const kind = pick(r, ['fields', 'fields', 'fields', 'acceptance', 'append', 'body']);
    if (kind === 'fields') return { kind, patch: { [pick(r, keys)]: pick(r, values) } };
    if (kind === 'acceptance') return { kind, n: pick(r, [1, 2]), checked: r() < 0.5 };
    if (kind === 'append') return { kind, heading: 'Comments', lines: ['An added comment.'] };
    return { kind, suffix: '\nAn added paragraph.' };
  });
}
