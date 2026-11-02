import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../core/extract.mjs';
import { parseJournal, parseLinks } from '../core/links.mjs';
import { PRESETS } from '../core/presets.mjs';
import { resolveSchema } from '../core/schema.mjs';

const types = PRESETS.default.entryTypes;
const targets = (links) => links.map((link) => [link.targetName, link.field, link.line]);

test('parseLinks reads the frontmatter itself when no options are given', () => {
  assert.deepEqual(targets(parseLinks('---\nsources: ["[[src]]"]\n---\n[[body]]\n')), [['src', 'sources', 2], ['body', null, 4]]);
  assert.deepEqual(targets(parseLinks('---\nsources: ["[[broken"\n---\n[[body]]\n')), [['broken', null, 2], ['body', null, 4]]);
});

test('broken frontmatter yields links even without a closing bracket pair', () => {
  const links = parseLinks('---\nsources: ["[[acme#part|x", "[[zorblax\n---\n', { frontmatter: null, frontmatterText: 'sources: ["[[acme#part|x", "[[zorblax\n' });
  assert.deepEqual(targets(links), [['acme', null, 2], ['zorblax', null, 2]]);
});

test('escaped links are text and code spans do not cross blank lines', () => {
  assert.deepEqual(targets(parseLinks('\\[[literal]] [[real]]\n')), [['real', null, 1]]);
  assert.deepEqual(targets(parseLinks('a ` b\n\n[[seen]] ` c\n')), [['seen', null, 3]]);
});

test('journal: an h1 ends the section, nested items continue their entry, bold label with outer colon', () => {
  const text = '## Work · acme\n- **Karar**: Option A\n  - detail one\n  - detail two\n\n# Standup\n- not an entry\n';
  const entries = parseJournal(text, types);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'decision');
  assert.equal(entries[0].text, 'Option A\n- detail one\n- detail two');
});

test('headings indented by up to three spaces are titles', () => {
  const schema = resolveSchema({ schema: PRESETS.default });
  assert.equal(extract(schema, 'notes/a.md', '   # Acme\n').title, 'Acme');
  assert.equal(extract(schema, 'notes/a.md', '    # Code\n').title, 'a');
});
