import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../core/extract.mjs';
import { parseJournal, parseLinks } from '../core/links.mjs';
import { PRESETS } from '../core/presets.mjs';
import { resolveSchema } from '../core/schema.mjs';

const schema = resolveSchema({ schema: PRESETS.default });
const n = 200000;

// Quadratic parsing of one hostile line would hang indexing for minutes; linear parsing takes milliseconds.
test('hostile long lines parse in linear time', () => {
  const cases = [
    () => extract(schema, 'notes/a.md', `# a${' '.repeat(n)}b\n`),
    () => extract(schema, 'notes/a.md', `# a${' '.repeat(n)}#x\n`),
    () => extract(schema, 'notes/a.md', `# a${' #'.repeat(n)}x\n`),
    () => parseLinks('[['.repeat(n)),
    () => parseLinks('[[a]] '.repeat(n / 4)),
    () => parseJournal(`## a${' '.repeat(n)}b\n- x\n`, schema.entryTypes ?? {}),
    () => parseJournal(`## a${' · '.repeat(n / 3)}b\n- x\n`, schema.entryTypes ?? {}),
    () => parseJournal(`## a\n- x ${'→ [['.repeat(n / 4)}\n`, schema.entryTypes ?? {}),
  ];
  for (const [index, run] of cases.entries()) {
    const start = performance.now();
    run();
    assert.ok(performance.now() - start < 1500, `case ${index}`);
  }
});

test('headings keep their meaning after the linear rewrite', () => {
  const title = (text) => extract(schema, 'notes/a.md', text).title;
  assert.equal(title('#   Acme   \n'), 'Acme');
  assert.equal(title('# Acme ##  \n'), 'Acme');
  assert.equal(title('# Acme#\n'), 'Acme#');
  assert.equal(title('# C# \n'), 'C#');
  assert.equal(title('#\tAcme\t#\t\n'), 'Acme');
  assert.equal(title('#Acme\n'), 'a');
  const [entry] = parseJournal('## Konu: Başlık  ·  acme  \n- x\n', schema.entryTypes ?? {});
  assert.equal(entry.heading, 'Başlık');
  assert.equal(entry.label, 'acme');
  assert.deepEqual(parseLinks('a [[b]]\n\nc [[d|e]] [[f]]').map((link) => [link.targetName, link.line]), [['b', 1], ['d', 3], ['f', 3]]);
});
